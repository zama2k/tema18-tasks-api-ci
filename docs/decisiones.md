# Decisiones de diseño

Formato: decisión, motivo y alternativa descartada. Lo importante primero.

## Probar el digest publicado y desplegar ese mismo digest

El job `Build image` construye y verifica la imagen (contenedor sano, `/health.commit` correcto, usuario no root, parada con SIGTERM). `Publish image` (solo en `main`) la **reconstruye con la misma caché de capas**, la publica en GHCR y **vuelve a verificar el digest ya publicado** con el mismo script. No es un «build once» literal: son dos construcciones del mismo `Dockerfile` y contexto, y la que se despliega es la segunda. La mitigación es que lo desplegado es siempre lo que se acaba de probar *después* de publicarlo; reutilizar el binario del primer job exigiría un `docker save`/`load` entre jobs (cientos de MB y otro punto de fallo), así que se descartó por ser lo más simple. Se publica además `image-digest.json` con `{sha, digest, image}` como artefacto. El CD:

1. descarga ese artefacto **del run de CI que lo disparó** (`run-id: github.event.workflow_run.id`);
2. comprueba que `sha == workflow_run.head_sha` ([`resolve-image.js`](../scripts/resolve-image.js)); si no coincide, aborta;
3. pide a Render desplegar `ghcr.io/<owner>/<repo>@sha256:...`; el script rechaza cualquier imagen que no vaya fijada por digest.

*Descartado:* reconstruir la imagen en el CD (sería una tercera construcción sin verificar), o desplegar `:main`/`:latest`. Un *tag* es mutable: entre el CI y el CD podría apuntar a otra cosa.

## `workflow_run` con `head_sha`

`workflow_run` ejecuta el workflow de la rama por defecto, y un `actions/checkout` sin `ref` se llevaría el HEAD **actual** de `main`, que puede ser un commit posterior al que pasó el CI. Todos los jobs del CD hacen checkout de `workflow_run.head_sha` y el health check exige que el servicio responda con ese mismo commit. Además el CD solo se activa con `conclusion == success` y evento `push` (nunca para PRs).

## El health check comprueba el commit, no solo el 200

Tras un despliegue la versión anterior puede seguir respondiendo `200` durante un rato (y el plan gratuito de Render arranca en frío en torno a 1 minuto). `/health` devuelve el `GIT_SHA` incrustado en la imagen; el health check reintenta con *backoff* exponencial (3, 6, 12, 24 y luego 30 s; 20 intentos) hasta ver el commit esperado. Los smoke tests solo corren después.

## Caché de `node_modules`

El enunciado pide «cache de `node_modules` basado en `package-lock.json`». Cachear `node_modules` es delicado:

| Riesgo | Mitigación aquí |
|---|---|
| `npm ci` borra `node_modules` antes de instalar, así que cachear el directorio no acelera nada **si** se vuelve a ejecutar | Con acierto de caché **se salta `npm ci`** |
| Una clave solo por SO restaura módulos de otra versión de Node o de otro lockfile | Clave exacta: `SO` + arquitectura + **versión exacta de Node** + `hashFiles('package-lock.json')` |
| `restore-keys` entregaría una caché parcial y, al saltarnos `npm ci`, nadie la corregiría | **Sin `restore-keys`** |
| Saltarse `npm ci` omite también los *scripts* de instalación | Los módulos restaurados ya los llevan ejecutados; la clave incluye la versión de Node (ABI) |

En el fallo de caché (primera vez, lockfile nuevo) entra la segunda capa: una caché de `~/.npm` (contenido direccionable, por lo que `restore-keys` es seguro ahí) que hace que `npm ci` baje poco de red. Se restaura **solo en ese caso** y no con `cache: npm` de `setup-node`, que la restauraría siempre, incluso con acierto de `node_modules` y en los jobs que no instalan nada. La acción compuesta [`setup-project`](../.github/actions/setup-project/action.yml) no declara outputs (nadie los leía) y escribe el acierto o fallo de caché en el resumen de cada job; el «segundo run usa la caché» se verifica ahí. Las cachés creadas en un PR solo son visibles para ese PR; las de `main` las pueden leer todos los PRs.

## Permisos mínimos y acciones fijadas

- `permissions: contents: read` a nivel de workflow; se amplía por job: `packages: write` solo en `Publish image`, `contents: write` solo en `Publish coverage badges`, `pull-requests: write` solo en `Coverage report`, `actions: read` solo en el job de despliegue del CD.
- Todas las acciones de terceros van por **SHA completo con la versión en comentario**; `.github/dependabot.yml` propone las actualizaciones (acciones, npm y Docker).
- Ningún valor controlable por un usuario (nombres de rama, títulos, entradas) se interpola en `run:`: se pasa por `env:`.
- `timeout-minutes` en todos los jobs; `concurrency` en CI (cancela solo dentro de un mismo PR) y en CD (`cancel-in-progress: false`, un despliegue a medias es peor que esperar).
- El job `Publish coverage badges` es el único con escritura en el repo, y solo escribe en la rama huérfana `badges`.

## Concurrencia: lo que GitHub hace de verdad

Con `cancel-in-progress: false` GitHub deja **un solo run pendiente** por grupo y **cancela el pendiente anterior** cuando llega otro. Dos consecuencias:

- **CI**: un grupo compartido entre commits haría que un commit de `main` se quedara sin CI, sin imagen y sin despliegue si llegan dos pushes seguidos. El grupo es `ci-pr-<número>` en pull requests (cancela dentro del PR) y `ci-<sha>` en push y ejecuciones manuales (nada se cancela). `queue: max` no se usa: `actionlint` 1.7.12 no lo acepta.
- **CD**: la cola de un solo hueco es aceptable porque cada despliegue lleva la punta de `main` de su momento. Pero un run que ya estaba esperando puede arrancar cuando `main` ya avanzó; [`check-superseded.js`](../scripts/check-superseded.js) compara `head_sha` con la punta de `main` (API de GitHub) y, si no coincide, salta el despliegue con un `::notice::` y un resumen. Si la API falla, avisa y despliega: perder un despliegue es peor que repetirlo.

## Lint de shell con una versión fijada

`ubuntu-latest` trae `shellcheck` 0.9.0, que no conoce `SC2329` (la regla de «función invocada indirectamente» de 0.11) y emite `SC2317` en las funciones que solo llama un `trap`. En lugar de depender del que traiga el runner, el CI ejecuta `koalaman/shellcheck:v0.11.0` igual que `actionlint`, y los scripts desactivan ambos códigos en esas funciones para que pasen también con 0.9.0 (comprobado con ambas imágenes).

## `CI OK`: un único check estable para la protección de rama

Los checks de una matriz cambian de nombre si se cambia la matriz y romperían la protección de rama. `CI OK` (`if: always()`, `needs` de todos los jobs) falla si alguno falló o se canceló y acepta los omitidos legítimos (`Publish image` en un PR, por ejemplo). La protección exige `CI OK` y también los checks individuales.

## Mutación: bloqueante en PR, informativa en push

Stryker tarda ~3,5 minutos. En un PR el umbral `break` (50 %) bloquea; en un push a `main`/`develop` el paso tiene `continue-on-error` y emite un `::warning::`, de modo que un descenso puntual no impide construir y publicar la imagen de un commit ya aprobado, pero queda visible. El umbral actual está lejos de la medición (86,56 %), así que solo saltará ante una degradación real.

## Cobertura: dónde se exige el 80 %

El umbral global está en `jest.config.js` y lo exige la suite **unitaria** (en los 4 Node y en `npm test`). La suite de integración se ejecuta con `--coverageThreshold='{}'` porque cubre otra porción del código (66 % de líneas): lo que importa de ella es el comportamiento real contra PostgreSQL, y su porcentaje solo se informa.

`src/server.js` y `src/db/cli.js` están excluidos de la cobertura (son puntos de entrada del proceso, igual que el `server.js` excluido en el enunciado) pero **sí se ejecutan** en los tests de integración y E2E (arranque real, migraciones por CLI, error de puerto ocupado).

## Pruebas de integración aisladas por *schema*

Jest ejecuta ficheros en paralelo. Cada fichero de integración crea su propio *schema* (`it_<pid>_<aleatorio>`), fija `search_path` en su pool y lo borra al terminar. Resultado: BD limpia por test (`TRUNCATE ... RESTART IDENTITY`), cero interferencia entre ficheros y sin tocar datos reales aunque se apunte a una base existente.

## Repositorio y filas «crudas»

El patrón repositorio devuelve filas con la forma de la base de datos (`created_at` como `Date`) tanto en memoria como en PostgreSQL; `formatTask` las convierte al JSON público. Así el repositorio en memoria se comporta como el real y las funciones puras tienen un trabajo real que testear.

## Express 5 y errores asíncronos

Express 5 reenvía a `next()` los rechazos de promesas de los manejadores, por lo que los controladores `async` simplemente lanzan `HttpError`. Hallazgo durante las pruebas: `app.listen(puerto, callback)` en Express 5 llama al callback **también cuando falla** (por ejemplo `EADDRINUSE`) pasándole el error; resolver la promesa sin mirar ese argumento devolvía un servidor que nunca llegó a escuchar. Hay un test que lo cubre.

## Parada ordenada

`CMD ["node","src/server.js"]` en forma *exec* y sin `npm start`: Node es el PID 1 y recibe SIGTERM. [`registerShutdown`](../src/bootstrap.js) deja de aceptar conexiones, cierra las inactivas (en Node 18 `close()` espera a las *keep-alive*), cierra el pool de PostgreSQL y sale con 0; un temporizador fuerza la salida con 1 si algo se cuelga. `verify-image.sh` lo comprueba con `docker stop`.

## Dependencias: tres fijaciones no evidentes

Descubiertas al probar en contenedores Linux limpios con `npm ci`, no en la máquina de desarrollo:

1. **`@emnapi/core` y `@emnapi/runtime` como `devDependencies` explícitas.** Un lockfile generado en Windows omite estas dependencias opcionales de WebAssembly y `npm ci` falla en Linux («lock file not in sync»).
2. **`@babel/core@7`.** Stryker 10 trae Babel 8 (solo ESM); `npm` lo elevaba a la raíz y `babel-jest` fallaba con `ERR_REQUIRE_ESM` en Node 18, 20 y 22 antiguos.
3. **Cierre de conexiones en los servidores de test** (`closeAllConnections`), porque en Node 18 `server.close()` espera a las conexiones *keep-alive* que deja `fetch`.

## Por qué los scripts son CommonJS `.js` y sin dependencias

Jest corre en Node 18 y los tests de los scripts los `require` directamente; un `.mjs` exigiría `--experimental-vm-modules`. Además, el job de CD solo necesita Node, sin `npm ci`: los scripts de despliegue no dependen de nada instalado.

## Windows y Git Bash

- `.gitattributes` fuerza LF (`* text=auto eol=lf`), imprescindible para los `.sh`.
- Los scripts de Node terminan con `process.exitCode`, no con `process.exit()`: llamar a `exit()` justo después de un `fetch` aborta libuv en Windows.
