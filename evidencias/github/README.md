# Evidencias en GitHub Actions y Render

Ejecuciones reales, comprobadas el 2026-10-27. Las salidas locales siguen en [`../local/`](../local/README.md).

- Repositorio: <https://github.com/zama2k/tema18-tasks-api-ci>
- Staging: <https://tema18-tasks-api-ci-staging.onrender.com/health> (sirve el commit `f9e6477`, versión 1.0.0)

## Resumen

| # | Qué se demuestra | Ejecución | Commit | Resultado |
|---|---|---|---|---|
| 1 | CI completo en `main`: 11 checks requeridos, imagen en GHCR y badges | [CI 40490398070](https://github.com/zama2k/tema18-tasks-api-ci/actions/runs/40490398070) | `3a4ef86` | success |
| 2 | CD Staging, intento 1: sin secretos de Render, **no despliega** y lo avisa | [CD Staging 40490936060](https://github.com/zama2k/tema18-tasks-api-ci/actions/runs/40490936060) (intento 1) | `3a4ef86` | success, con `Health check` y `Smoke tests` *skipped* |
| 3 | CD Staging, intento 2: despliegue real por digest en Render | [CD Staging 40490936060](https://github.com/zama2k/tema18-tasks-api-ci/actions/runs/40490936060) (intento 2) | `3a4ef86` | success (deploy, health, 12 smoke tests, Discord) |
| 4 | El CI **bloquea** un upgrade que rompe Node 18 | [CI 40490586196](https://github.com/zama2k/tema18-tasks-api-ci/actions/runs/40490586196) | `02e83a9` (PR #2) | **failure** en `Unit tests (Node 18)`; `Build image` skipped |
| 5 | PR #3 con comentario pegajoso de cobertura y mutación | [CI 40521896747](https://github.com/zama2k/tema18-tasks-api-ci/actions/runs/40521896747) | `b8bc6d7` | success, 11 checks requeridos |
| 6 | CI en `main` tras el merge del PR #3 | [CI 40523567823](https://github.com/zama2k/tema18-tasks-api-ci/actions/runs/40523567823) | `084901b` | success |
| 7 | CD Staging disparado por ese CI | [CD Staging 40524244137](https://github.com/zama2k/tema18-tasks-api-ci/actions/runs/40524244137) | `084901b` | success (deploy 44 s hasta `live`, health, 12 smoke tests, Discord) |
| 8 | CI en `main` y CD Staging del commit de documentación | [CI 40524744692](https://github.com/zama2k/tema18-tasks-api-ci/actions/runs/40524744692) y [CD Staging 40525346785](https://github.com/zama2k/tema18-tasks-api-ci/actions/runs/40525346785) | `f9e6477` | success; aviso de Discord recibido a las 15:53 |

## CI en `main` (filas 1 y 6)

| Job | Resultado |
|---|---|
| `Lint` (ESLint, actionlint, shellcheck) | success |
| `Unit tests (Node 18/20/22/24)` | success en las cuatro versiones |
| `Integration tests` (PostgreSQL 16 como *service*) | success |
| `E2E tests (shard 1/2)` y `E2E report` | success |
| `Mutation tests` | success |
| `Build image` | success |
| `Publish image` | success; publica en GHCR, verifica el digest y sube el artefacto `image-digest` |
| `Publish coverage badges` | success; actualiza la rama `badges` (coverage 100 %, mutation score 86,6 %) |
| `Coverage report` | skipped (solo en PR) |
| `CI OK` | success |

Artefactos del primer run: `coverage-unit-node-18/20/22/24`, `coverage-integration`, `blob-report-1/2`, `playwright-report`, `mutation-report` e `image-digest`.

## CD Staging (filas 2, 3 y 7)

El CD despliega `workflow_run.head_sha` y el **digest** del artefacto del CI, nunca el HEAD de `main`.

| Comprobación | Fila 3 (`3a4ef86`) | Fila 7 (`084901b`) |
|---|---|---|
| Despliegue en Render | `dep-dbg8oqqvcj2c73bgm7s0`, `live` en 23 s | `dep-dbgbia2fngtc7398gco0`, `live` en 44 s |
| Health check | `healthy`, commit `3a4ef86` al primer intento | `healthy`, commit `084901b` al primer intento |
| Smoke tests | 12 `PASS` | 12 `PASS` |
| Notificación | Job `Notify Discord` en success; aviso recibido a las 12:35 | Job `Notify Discord` en success; aviso recibido a las 15:47 |

**Aviso importante sobre la fila 2.** El primer intento del CD se lanzó antes de configurar Render. Terminó en verde porque el paso de Render se salta con `::notice::` cuando faltan `RENDER_API_KEY` y `RENDER_SERVICE_ID`, pero sin health check ni smoke tests. Un verde del CD solo vale si esos dos jobs no están *skipped*. Tras configurar Render, se relanzó el mismo run (intento 2) y esa vez sí desplegó.

## Protección de `main`

| Elemento | Valor |
|---|---|
| Checks requeridos (11) | `CI OK`, `Lint`, `Unit tests (Node 18)`, `(Node 20)`, `(Node 22)`, `(Node 24)`, `Integration tests`, `E2E tests (shard 1)`, `(shard 2)`, `Mutation tests`, `Build image` |
| Rama al día (`strict`) | Sí |
| Aprobaciones requeridas | 1 |
| Conversaciones resueltas | Sí |
| `enforce_admins` | Desactivado |
| Environment `staging` | Solo despliega desde `main` |

**Decisión consciente:** con una sola cuenta nadie puede aprobar su propio PR, así que el merge se hace con `gh pr merge --admin`. El [PR #3](https://github.com/zama2k/tema18-tasks-api-ci/pull/3) se mergeó así: sus 11 checks estaban en verde y solo faltaba la aprobación.

## Hallazgo real: Dependabot y la matriz de Node

| Paso | Qué pasó |
|---|---|
| 1 | Dependabot abrió el PR #2 (`@babel/core` 7 a 8, que exige Node `^22.18 \|\| >=24.11`). [CI 40490586196](https://github.com/zama2k/tema18-tasks-api-ci/actions/runs/40490586196): `Unit tests (Node 18)` falla, `Build image` no se ejecuta y `CI OK` queda en rojo. **El CI bloqueó el upgrade** |
| 2 | Dependabot abrió también el PR #1 (imagen base `node:24` a `node:26`). Su CI **pasó en verde**: la matriz no prueba el runtime de la imagen, así que aquí el CI no habría detectado nada |
| 3 | El [PR #3](https://github.com/zama2k/tema18-tasks-api-ci/pull/3) (`ci(deps): skip major bumps that drop the supported Node versions`) añade a `.github/dependabot.yml` reglas `ignore` de *semver-major* para `@babel/*` y para la imagen `node` |
| 4 | Los PR #1 y #2 se cerraron con un comentario que explica el motivo y enlaza al run y al PR #3 |
| 5 | Tras el merge, Dependabot abrió el PR #4 (`node` 24.12.0 a 24.22.1, sin saltar de mayor) y el PR #5 (dev-dependencies: 2 actualizaciones de `@emnapi`, sin Babel). Sus CI pasaron en verde ([CI 40523702229](https://github.com/zama2k/tema18-tasks-api-ci/actions/runs/40523702229) y [CI 40523768196](https://github.com/zama2k/tema18-tasks-api-ci/actions/runs/40523768196)) |

Subir de mayor sigue siendo posible, pero como un cambio deliberado de matriz, `engines` y dependencias a la vez.

## Cobertura y mutación en el PR #3

Comentario único y actualizable del [PR #3](https://github.com/zama2k/tema18-tasks-api-ci/pull/3):

| Métrica | Valor |
|---|---|
| Unitarios: sentencias / ramas / funciones / líneas | 100 % / 97,74 % / 98,78 % / 100 % (umbral 80 %) |
| Integración (informativa): sentencias | 64,9 % |
| Mutación (Stryker) | 86,6 %: 522 muertos, 19 *timeout*, 84 supervivientes, 0 sin cobertura, 625 válidos |

`Publish image` y `Publish coverage badges` se saltan en PR: solo corren en `main`.

## Caché

| Run | Resultado |
|---|---|
| [CI 40490398070](https://github.com/zama2k/tema18-tasks-api-ci/actions/runs/40490398070) (primero) | `Cache not found for input keys: node-modules-...` |
| [CI 40521896747](https://github.com/zama2k/tema18-tasks-api-ci/actions/runs/40521896747) | `Cache hit for: node-modules-Linux-X64-nodev...` en los jobs de unitarios, integración, lint, mutación y E2E |

## Recepción en Discord

**VERIFICADO:** recepción confirmada con captura del canal `#deploys` aportada por el autor (servidor `tema18-deploys`, 27-10-2026, hora local de España, UTC+1). La captura no está como fichero en el repositorio: se documenta por transcripción.

Mensajes de este repositorio (bot «Tasks API CI»):

| Hora | Título | Datos clave | Corresponde a |
|---|---|---|---|
| 11:45 | Staging deploy skipped | «Render is not configured (RENDER_API_KEY / RENDER_SERVICE_ID); the image was published but not deployed». Commit `3a4ef86`, digest `sha256:658fb314…cbbc` | Fila 2 (intento 1) |
| 12:35 | Staging deploy succeeded | Commit `3a4ef86`, despliegue en 23 s, URL de staging, mismo digest | Fila 3 (intento 2) |
| 15:47 | Staging deploy succeeded | Commit `084901b`, despliegue en 44 s, digest `sha256:2c496efb…7265` | Fila 7 |
| 15:53 | Staging deploy succeeded | Commit `f9e6477`, despliegue en 23 s, digest `sha256:692b1ff5…c9a8` | Fila 8 |

Lo que confirma:

- El aviso «skipped» de las 11:45 prueba que el primer CD en verde **no desplegó**, tal y como se describe en la fila 2.
- Cada despliegue real de staging produjo su aviso con commit, tiempo y digest.

## Qué no hemos verificado

| Punto | Estado |
|---|---|
| `202 Queued` de Render | Solo probado contra el servidor falso: Render devolvió siempre un despliegue ya creado |
| Fallo E2E en Actions | No se ha provocado, así que no se han visto los artefactos `e2e-failures-shard-N` |
| Fallo del CD con rollback | No existe: este ejercicio no tiene rollback automático |
| Capturas de pantalla | No incluidas como fichero; la de Discord se transcribe arriba |
