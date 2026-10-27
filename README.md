# Tasks API con CI/CD basado en tests automáticos

[![CI](https://github.com/zama2k/tema18-tasks-api-ci/actions/workflows/ci.yml/badge.svg)](https://github.com/zama2k/tema18-tasks-api-ci/actions/workflows/ci.yml)
[![CD Staging](https://github.com/zama2k/tema18-tasks-api-ci/actions/workflows/cd-staging.yml/badge.svg)](https://github.com/zama2k/tema18-tasks-api-ci/actions/workflows/cd-staging.yml)
![Coverage](https://img.shields.io/endpoint?url=https%3A%2F%2Fraw.githubusercontent.com%2Fzama2k%2Ftema18-tasks-api-ci%2Fbadges%2Fcoverage.json)
![Mutation score](https://img.shields.io/endpoint?url=https%3A%2F%2Fraw.githubusercontent.com%2Fzama2k%2Ftema18-tasks-api-ci%2Fbadges%2Fmutation.json)
![Node](https://img.shields.io/badge/node-18%20%7C%2020%20%7C%2022%20%7C%2024-339933)

API REST de tareas (Node.js 24, Express 5, PostgreSQL) cuyo objetivo real es el **pipeline**: ningún código llega a staging sin pasar lint, tests unitarios con umbral de cobertura del 80 %, tests de integración contra PostgreSQL real, E2E con navegador y mutation testing. La imagen Docker que se despliega se identifica por su *digest* y es la que se verifica justo después de publicarla.

## Nota para la corrección

Todo lo que se puede ejecutar en un ordenador **se ha ejecutado de verdad** y su salida está en [`evidencias/local/`](evidencias/local/README.md). Lo que depende de plataformas externas **todavía no se ha podido comprobar**:

| Pendiente | Por qué | Cuándo se añadirá |
|---|---|---|
| Ejecuciones reales en GitHub Actions (capturas de checks, comentario del PR, artefactos, badges) | El repositorio aún no está publicado | Tras publicar el repo |
| Despliegue real en Render y URL de staging | Requiere cuenta de Render y secretos | Tras publicar el repo y crear el servicio |
| Notificación real en Discord | Requiere el webhook | Igual |
| Protección de rama real | `scripts/setup-github.sh` está escrito y probado con un `gh` falso, pero no se ha ejecutado contra GitHub | Tras publicar |
| Segunda ejecución con caché (`cache-hit: true`) | Solo observable en Actions; el job escribe el resultado en el *step summary* | Tras publicar |

Los marcadores `__GH_OWNER__` (badges y URLs) se sustituirán por el usuario de GitHub al publicar. Detalle completo en [Limitaciones honestas](#limitaciones-honestas).

## Qué demuestra este repositorio

- **Nivel 1, 2 y 3 del enunciado, incluidos los bonus** (E2E, CD con smoke tests, Stryker, paralelización). Tabla requisito → lugar exacto en [`docs/enunciado.md`](docs/enunciado.md).
- Evita los fallos típicos de los pipelines de ejemplo: el CD despliega el commit que pasó el CI (no el HEAD de `main`), la integración usa PostgreSQL de verdad, los smoke tests apuntan a una URL real desplegada, `permissions:` mínimos, acciones fijadas por SHA, nada de `${{ }}` de datos externos dentro de `run:`. Ver [decisiones](docs/decisiones.md).

## Arquitectura

```
                         pull_request / push (main, develop)
                                      |
 +-------------------------------- CI (ci.yml) ---------------------------------+
 |                                                                               |
 |  Lint + actionlint + shellcheck     Unit x Node 18/20/22/24 (umbral 80 %)     |
 |  Integration (service PostgreSQL)   E2E Playwright (2 shards) -> informe HTML |
 |  Mutation (Stryker)                                                           |
 |        \             |               |              /                         |
 |         +------------+---------------+-------------+                          |
 |                      v                                                        |
 |        Build image (verifica: healthy, commit, no root, SIGTERM)              |
 |                      |   solo push a main                                     |
 |                      v                                                        |
 |        Publish image -> ghcr.io/<owner>/<repo>@sha256:...  (+ artefacto       |
 |                          image-digest con el commit; se verifica el digest)   |
 |  PR: comentario de cobertura + mutación | main: badges | CI OK (check único)  |
 +-------------------------------------------------------------------------------+
                                      | workflow_run (success, push, main)
                                      v
 +------------------------------ CD (cd-staging.yml) ------------------------------+
 |  Deploy staging (environment: staging)                                        |
 |    descarga image-digest del run de CI, comprueba que su sha == head_sha      |
 |    -> API de Render: despliega ese digest y espera a "live"                   |
 |  Health check (reintentos + backoff; /health.commit == head_sha)              |
 |  Smoke tests (/health, CRUD completo con limpieza, 404, 400)                  |
 |  Notify (Discord: éxito / fallo / omitido) + resumen del run                  |
 +-------------------------------------------------------------------------------+

 Navegador --> Express 5 (createApp) --> controlador --> repositorio --+--> memoria
                                                                       +--> PostgreSQL (DATABASE_URL)
```

## Ejecutar en local

Requisitos: Node 20 o superior (la app funciona desde Node 18; las herramientas de lint, E2E y mutación piden 20/22+) y Docker para PostgreSQL.

```bash
npm ci
cp .env.example .env          # opcional, ver variables en el propio fichero
docker compose up -d db       # PostgreSQL 16 en el puerto 5432 (DB_PORT=55432 para cambiarlo)
export DATABASE_URL=postgresql://postgres:postgres@localhost:5432/tasks

npm run db:migrate            # aplica src/db/migrations/*.sql
npm start                     # http://localhost:3000  (sin DATABASE_URL usa memoria)
```

| Comando | Qué hace |
|---|---|
| `npm run lint` | ESLint 10 (configuración *flat*) |
| `npm run test:unit` | Unitarios, sin red ni base de datos. Añade `-- --coverage` para el umbral del 80 % |
| `npm run test:integration` | API + PostgreSQL real (necesita `DATABASE_URL`). Cada fichero trabaja en su propio *schema* |
| `npm test` | Unitarios + integración con cobertura y umbral global del 80 % |
| `npm run test:e2e` | Playwright (Chromium) contra `src/server.js` + PostgreSQL. Primera vez: `npx playwright install chromium` |
| `npm run test:mutation` | Stryker; informe en `reports/mutation/mutation.html` |
| `npm run build` | Comprueba que el árbol desplegable es completo y carga (no hay transpilado) |
| `docker compose --profile app up --build` | API + PostgreSQL en contenedores (puerto `APP_PORT`, 3000 por defecto) |

Verificar la imagen como lo hace el CI: `docker build -t tasks-api:local --build-arg GIT_SHA=$(git rev-parse HEAD) . && scripts/verify-image.sh tasks-api:local $(git rev-parse HEAD) 3000`.

Probar el despliegue sin cuenta de Render: [`scripts/fake-render-server.js`](scripts/fake-render-server.js) imita los dos endpoints usados (`node scripts/fake-render-server.js --port 3102`, luego `scripts/render-deploy.js --api-url http://127.0.0.1:3102/v1 ...`).

## API

| Método y ruta | Descripción |
|---|---|
| `GET /health` | Liveness: `{status:"healthy", version, commit, storage, uptime}`. `commit` es el `GIT_SHA` incrustado en la imagen |
| `GET /ready` | Readiness: comprueba la base de datos; 503 si no responde |
| `GET /api/tasks` | Lista. Filtros `?status=pending\|in_progress\|done` y `?sort=priority` |
| `POST /api/tasks` | Crea (`title` obligatorio, `priority`, `status`, `description`). 201 + `Location` |
| `GET /api/tasks/stats` | Totales por estado y prioridad, tasa de finalización |
| `GET /api/tasks/:id` · `PUT` · `DELETE` | Leer, actualizar (parcial) y borrar. Id inválido: 400; inexistente: 404 |

Errores siempre JSON `{error:{code,message,details?}}`; un 500 nunca expone el mensaje interno ni el *stack*. `x-powered-by` desactivado y cabeceras de seguridad con Helmet. La UI estática de `public/` consume esta API.

## Cómo funciona el pipeline

### `ci.yml` (nombre `CI`)

Se ejecuta en `push` a `main`/`develop`, `pull_request` a `main` y manualmente. Concurrencia: un PR cancela su ejecución anterior; push y ejecuciones manuales usan un grupo **por commit**, así que ninguna ejecución de otro commit las cancela (con un grupo compartido GitHub cancelaría la ejecución *pendiente*, y ese commit se quedaría sin CI ni imagen).

| Job (nombre del check) | Hace | Notas |
|---|---|---|
| `Lint` | ESLint, `actionlint` 1.7.12 y `shellcheck` v0.11.0, ambos como imagen Docker fijada | El `shellcheck` de `ubuntu-latest` cambia con la imagen del runner (0.9.0 hoy), por eso no se usa; los scripts pasan también con 0.9.0 |
| `Unit tests (Node 18/20/22/24)` | `jest --selectProjects unit --coverage` | `fail-fast: false`; falla si cobertura < 80 %; artefacto `coverage-unit-node-<versión>` |
| `Integration tests` | Service `postgres:16-alpine` con *healthcheck*; `db:migrate`; tests | Cobertura informativa (`coverage-integration`) |
| `E2E tests (shard 1/2)` | Playwright en 2 *shards*, cada uno con su PostgreSQL | Caché de navegadores; artefactos `blob-report-N` y, solo si falla, `e2e-failures-shard-N` (capturas, vídeo, *trace*) |
| `E2E report` | Une los *blob reports* en un informe HTML | Artefacto `playwright-report` |
| `Mutation tests` | Stryker; umbral `break` 50 % | Bloquea en PR; en push solo avisa (`::warning::`). Artefacto `mutation-report` |
| `Coverage report` (solo PR) | Comentario **pegajoso**: se localiza por un marcador HTML oculto y se actualiza, no se duplica | Cobertura + mutación. Codecov solo si existe `CODECOV_TOKEN`. En PRs de forks va al *summary* |
| `Build image` | `npm run build`, `docker build`, y [`verify-image.sh`](scripts/verify-image.sh) | Healthy, `commit` correcto, no root, parada con SIGTERM = código 0 |
| `Publish image` (solo push a `main`) | Publica en GHCR `sha-<sha completo>` y `main`, **verifica el digest publicado** y sube el artefacto `image-digest` | `packages: write` solo aquí. Reconstruye con la misma caché de capas que `Build image` (no reutiliza el binario del job anterior); lo que se despliega es lo que se verifica *después* de publicar |
| `Publish coverage badges` (solo push a `main`) | Escribe JSON de shields.io en la rama `badges` | `contents: write` solo aquí |
| `CI OK` | Agrega todos los jobs; falla si alguno falló o se canceló | Check requerido estable |

`build` depende de `lint`, `test-unit`, `test-integration` y `test-e2e`; esos cuatro corren en paralelo.

### `cd-staging.yml` (nombre `CD Staging`)

Se dispara con `workflow_run` del CI en `main`, solo si `conclusion == success` y el evento fue un `push`. **Todo usa `workflow_run.head_sha`**, nunca el HEAD actual de `main`.

0. **Superseded**: si `head_sha` ya no es la punta de `main` (otro commit se fusionó mientras este run esperaba), el run se salta con `::notice::` para que un run viejo que llega tarde no pise un despliegue más nuevo ([`check-superseded.js`](scripts/check-superseded.js); si la API de GitHub falla, avisa y despliega).
1. **Deploy to staging** (`environment: staging`): descarga `image-digest` del run del CI, [`resolve-image.js`](scripts/resolve-image.js) aborta si el commit del artefacto no es `head_sha`, y [`render-deploy.js`](scripts/render-deploy.js) pide a Render desplegar ese digest y sondea hasta `live` (fallo, cancelación o *timeout* = job rojo). Si Render contesta `202 Queued` sin cuerpo, localiza el despliegue entre los 20 más recientes por el digest de la imagen y la hora de creación (nunca `limit=1`) y lo sondea igual.
2. **Health check**: [`wait-for-health.js`](scripts/wait-for-health.js) reintenta con *backoff* exponencial (3 s a 30 s, 20 intentos) y exige que `/health.commit == head_sha`. Con el plan gratuito de Render el arranque en frío tarda en torno a un minuto, y esta comprobación evita dar por bueno el servicio anterior.
3. **Smoke tests**: [`smoke.js`](scripts/smoke.js) ejecuta 12 comprobaciones contra la URL real y borra siempre lo que crea.
4. **Notify**: embed de Discord (estado, SHA corto, URL, digest, enlace al run) en éxito, fallo u omitido; además un resumen del run con URL, SHA, digest y tiempos.

`concurrency: deploy-staging` con `cancel-in-progress: false`: un despliegue en curso nunca se aborta. GitHub conserva **un solo run pendiente** por grupo: si se acumulan varios merges, solo espera el último y los intermedios se cancelan (no se pierde nada, porque el último despliega la punta de `main`).

Si falta un secreto, el paso correspondiente se **salta con `::notice::`** (Render, Discord, Codecov) y nunca falla en silencio ni imprime valores.

## Cobertura, mutación y tests: lo medido

Cifras de la ejecución local (ver evidencias; las de Actions se añadirán al publicar):

| Qué | Resultado |
|---|---|
| Tests unitarios | 317 (20 ficheros), 6,5 s |
| Cobertura de los unitarios | sentencias 100 %, ramas 97,74 %, funciones 98,78 %, líneas 100 % (umbral: 80 % en las cuatro) |
| Tests de integración (PostgreSQL 16) | 27 en 4 ficheros |
| `npm test` completo | 344 tests; ramas 98,87 % |
| E2E Playwright | 13 tests (8 UI + 5 API); dos shards de 7 y 6 |
| Mutación (Stryker) | **86,56 %**: 522 muertos, 19 *timeout*, 84 supervivientes, 0 sin cobertura (625 mutantes válidos) |
| Matriz Node 18/20/22/24 | unitarios en verde en contenedores Linux limpios (`npm ci` incluido) |
| Imagen Docker | 232 MB, usuario `node`, 80 paquetes de producción y ninguna herramienta de desarrollo |
| `actionlint` 1.7.12 / `shellcheck` 0.11.0 y 0.9.0 | sin avisos (la evidencia indica la versión usada) |

El umbral **falla de verdad**: añadir un módulo sin tests baja la cobertura al 54-58 % y Jest sale con código 1 ([evidencia](evidencias/local/06-umbral-cobertura-falla-de-verdad.txt)). Con la clave del enunciado (`coverageThresholds`, en plural) Jest solo emite un *warning* y sale con 0 ([evidencia](evidencias/local/07-errata-coverageThresholds-plural-no-falla.txt)).

## Configurar GitHub tras publicar el repo

1. Subir el repo y sustituir el marcador: `sd '__GH_OWNER__' 'tu-usuario' $(rg -l __GH_OWNER__)` (o con `sed -i`).
2. Crear en Render un servicio web **desde imagen existente** `ghcr.io/<usuario>/tema18-tasks-api-ci:main`, *health check path* `/health`, y (opcional) una base PostgreSQL con `DATABASE_URL` y `AUTO_MIGRATE=true`. Detalles en [`docs/plataformas.md`](docs/plataformas.md).
3. Tras el primer push a `main`, poner el paquete de GHCR en **público** (Package settings) o dar credenciales de registro a Render.
4. Ejecutar `scripts/setup-github.sh` (con `gh` autenticado; `--dry-run` para ver qué hará).

| Nombre | Tipo | Ámbito | Para qué |
|---|---|---|---|
| `RENDER_API_KEY` | Secret | Environment `staging` | Autenticar la API de Render |
| `RENDER_SERVICE_ID` | Variable | Environment `staging` | Servicio a desplegar (`srv-...`) |
| `STAGING_URL` | Variable | Environment `staging` | URL pública de staging (health check, smoke, enlace del entorno) |
| `DISCORD_WEBHOOK_URL` | Secret | Repositorio | Notificaciones |
| `CODECOV_TOKEN` | Secret (opcional) | Repositorio | Subida a Codecov; sin él se salta con aviso |
| `staging` | Environment | Repositorio | Solo desplegable desde `main` |

**Protección de `main`** (la aplica el script): PR obligatorio, 1 aprobación, ramas al día, conversaciones resueltas, sin *force-push*, y los checks `CI OK`, `Lint`, `Unit tests (Node 18/20/22/24)`, `Integration tests`, `E2E tests (shard 1/2)`, `Mutation tests` y `Build image`. Con una sola cuenta nadie puede aprobar su propio PR, así que `enforce_admins` queda en `false` y el merge se hace **con bypass de administrador**; es una decisión consciente y está documentada en el script.

## Decisiones de diseño y en qué mejora a lo habitual

Resumen; el razonamiento completo está en [`docs/decisiones.md`](docs/decisiones.md).

| Decisión | Por qué |
|---|---|
| Probar la imagen y desplegarla por digest | Se verifica el digest que está en el registro y es ese mismo digest el que se despliega; el CD no reconstruye nada |
| `workflow_run` con `head_sha` y comprobación del artefacto | Evita desplegar un commit distinto del validado |
| `/health.commit` forzado en el health check | Un 200 puede venir de la versión anterior |
| Caché de `node_modules` con clave exacta | `restore-keys` sobre `node_modules` + saltarse `npm ci` restauraría dependencias de otro lockfile |
| PostgreSQL real en integración y E2E | Los mocks no detectan restricciones, tipos ni concurrencia |
| `permissions` mínimos y acciones fijadas por SHA | Menor superficie ante una acción comprometida; Dependabot mantiene los SHA |
| Datos externos solo por `env:` | Evita inyección de scripts en `run:` |
| Sharding de Playwright por test, no por fichero | Con un solo fichero el segundo shard se quedaba vacío (detectado al ejecutarlo) |
| Scripts propios sin dependencias y con tests | Render, Discord y smoke se prueban sin cuentas reales |

## Limitaciones honestas

- **No se ha ejecutado ningún workflow en GitHub Actions.** Se validan sintácticamente con actionlint y cada paso lógico se ha ejecutado en local (scripts, contenedor, E2E, etc.), pero la integración entre acciones (`actions/cache`, `download-artifact` entre runs, `type=gha`, `strategy.job-total`) solo se confirmará en el primer run.
- **Render y Discord no se han probado contra servicios reales.** El cliente de Render sigue la documentación oficial consultada el 2026-10-27, y se prueba contra un servidor falso; un cambio de la API o una restricción del plan no se detectaría hasta el primer despliegue. El tratamiento del `202 Queued` (buscar el despliegue en el listado) se prueba solo contra el servidor falso, cuyo formato de listado sigue la documentación.
- **`Publish image` reconstruye la imagen** (misma caché de capas, mismo `Dockerfile` y contexto) en lugar de reutilizar la del job `Build image`: no es un «build once» literal. La mitigación es probar el digest ya publicado antes de que el CD lo vea; reutilizar el binario exigiría pasar un `docker save` entre jobs y se descartó por complejidad.
- **Un run pendiente del CD puede cancelarse** (comportamiento de GitHub). Es inocuo porque el último run despliega la punta de `main`, y el control de *superseded* evita lo contrario; si la API de GitHub no responde, ese control avisa y deja desplegar.
- **Sin rollback automático.** Un despliegue fallido deja el job en rojo y avisa por Discord; volver atrás implica relanzar el despliegue de un digest anterior (los digests de cada commit de `main` quedan en GHCR y en el artefacto de cada run).
- **Solo staging.** No hay producción en este ejercicio; el entorno `production` con revisor obligatorio pertenece al ejercicio de CD.
- **Las versiones recientes de las acciones** (`checkout` v7, `cache` v6, etc.) se han fijado por SHA tras comprobar su `action.yml`, pero no pude ejecutarlas; Dependabot propondrá actualizaciones.
- **La mutación se ejecuta en Node 24** (Stryker 10 exige Node 22 o superior) y tarda unos 3,5 minutos aquí; es el job más lento.
- **Los tests de scripts con `bash`, `git` o `jq` se omiten si la herramienta no existe** (en las imágenes `slim` de la matriz local se omitieron 11 tests; en Windows con Git Bash y en los runners de Ubuntu se ejecutan).
- **`SIGTERM` real solo se prueba en Linux/Docker**: en Windows un proceso hijo no puede recibirlo, por lo que el test de integración se limita a comprobar que arranca y se detiene; la parada ordenada se verifica con `docker stop` ([evidencia](evidencias/local/13-docker-verificar-imagen.txt)).
- **Sin SBOM ni *provenance* de la imagen** (`provenance: false`) para que Render descargue un manifiesto simple.
- **`docker-compose.yml` es solo para desarrollo**; usa credenciales de ejemplo.

## Estructura

```
.github/workflows/   ci.yml, cd-staging.yml
.github/actions/     setup-project (Node + caché)
src/                 app, rutas, controlador, repositorio, validadores, db (pool, migraciones), arranque
public/              UI estática
tests/               unit, integration, e2e
scripts/             despliegue Render, health check, smoke, Discord, informes, setup de GitHub
docs/                enunciado.md, decisiones.md, plataformas.md
evidencias/local/    salidas reales de las verificaciones locales
```
