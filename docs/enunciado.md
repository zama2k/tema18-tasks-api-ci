# Requisitos del enunciado y dónde se cumplen

Reto: *Setup de CI/CD con tests automáticos*. Estado: **✔ hecho y verificado en local**, **◐ hecho, pendiente de ver en GitHub/Render/Discord** (ver [Nota para la corrección](../README.md#nota-para-la-corrección)).

## Nivel 1: básico (obligatorio)

| Requisito | Dónde se cumple | Estado |
|---|---|---|
| API REST con Express, mínimo 3 endpoints | `src/app.js`, `src/routes/tasks.js`: `/health`, `/ready` y 6 rutas de `/api/tasks` | ✔ |
| Tests unitarios, mínimo 10 | 289 tests en `tests/unit/` (validadores, controlador, repositorios, rutas con supertest, scripts). [Evidencia](../evidencias/local/03-tests-unitarios-cobertura.txt) | ✔ |
| Scripts `test`, `test:unit`, `lint` | `package.json` (además `test:integration`, `test:e2e`, `test:mutation`, `build`, `db:migrate`) | ✔ |
| Fichero de configuración de ESLint | `eslint.config.js`. **Ver errata 2** | ✔ |
| CI en push a `main`/`develop` y `pull_request` a `main` | `.github/workflows/ci.yml` (`on:`) | ◐ |
| Job de lint | Job `Lint` | ◐ |
| Job de tests unitarios con coverage | Job `Unit tests (Node …)` | ◐ |
| Job de build que depende de lint y tests | Job `Build image`, `needs: [lint, test-unit, test-integration, test-e2e]` | ◐ |
| Lint y test en paralelo | Ninguno declara `needs` sobre el otro | ◐ |
| Subir el coverage como artefacto | `coverage-unit-node-<versión>` y `coverage-integration` (`actions/upload-artifact`) | ◐ |
| Jest falla si coverage < 80 % | `jest.config.js` → `coverageThreshold.global` = 80 en las 4 métricas. [Falla de verdad](../evidencias/local/06-umbral-cobertura-falla-de-verdad.txt). **Ver errata 1** | ✔ |
| El pipeline falla si no se alcanza | El job de unitarios ejecuta `npm run test:unit -- --coverage`; Jest sale con 1 | ◐ |
| Checks visibles en los PRs | Cada job es un check; `CI OK` los agrega | ◐ |
| Branch protection en `main` | `scripts/setup-github.sh` (PR, 1 aprobación, checks requeridos, sin *force-push*) | ◐ (script probado con `gh` falso) |

## Nivel 2: intermedio (recomendado)

| Requisito | Dónde se cumple | Estado |
|---|---|---|
| PostgreSQL como *service* en Actions | `ci.yml`, job `test-integration`: `postgres:16-alpine` con `--health-cmd pg_isready` | ◐ |
| Tests de integración con la BD real | `tests/integration/` (27 tests: API, repositorio, migraciones, proceso `server.js`). [Evidencia](../evidencias/local/04-tests-integracion-postgres.txt) | ✔ (contra PostgreSQL 16 en Docker) |
| Job separado `test-integration` | Mismo nombre en `ci.yml` | ◐ |
| Matrix Node 18 y 20 con `fail-fast: false` | `test-unit`: **18, 20, 22 y 24**, `fail-fast: false`. [Evidencia](../evidencias/local/21-matriz-node-18-20-22-24-linux.txt) | ✔ en contenedores Linux |
| Coverage a Codecov (o similar) | Comentario propio en el PR (tabla de cobertura y mutación) + badges por shields.io desde la rama `badges` + Codecov opcional si existe `CODECOV_TOKEN` | ◐ |
| Comentar el reporte en el PR | Job `Coverage report`, comentario idempotente por marcador. Salida de ejemplo: [evidencia](../evidencias/local/23-informe-pr-y-badges.txt) | ◐ |
| Caché de `node_modules` por `package-lock.json` | `.github/actions/setup-project/action.yml`; clave exacta con SO, arquitectura, versión exacta de Node y `hashFiles('package-lock.json')`. [Por qué](decisiones.md#caché-de-node_modules) | ◐ |
| Verificar que el segundo run usa la caché | La acción expone `cache-hit` y lo escribe en el *step summary* de cada job | ◐ |

## Nivel 3: avanzado (bonus)

| Requisito | Dónde se cumple | Estado |
|---|---|---|
| Playwright en el pipeline | Job `test-e2e` (`playwright.config.js`, `tests/e2e/tasks.e2e.test.js`) | ◐ (la suite pasa en local: [evidencia](../evidencias/local/08-e2e-playwright-postgres.txt)) |
| Levantar la app y correr E2E contra ella | `webServer` de Playwright arranca `src/server.js` con PostgreSQL | ✔ |
| Capturas/vídeos de fallos como artefactos | `screenshot: only-on-failure`, `video: retain-on-failure`, `trace: on-first-retry`; artefacto `e2e-failures-shard-N`. [Evidencia](../evidencias/local/09-e2e-artefactos-en-fallo.txt) | ✔ en local / ◐ subida |
| Deploy automático a staging cuando el CI pasa en `main` | `.github/workflows/cd-staging.yml` (`workflow_run`) → Render por digest | ◐ |
| Smoke tests post-deploy (health + endpoints críticos) | Jobs `Health check` y `Smoke tests`; scripts `wait-for-health.js` y `smoke.js`. [Evidencia](../evidencias/local/15-smoke-contra-contenedor-con-postgres.txt) | ✔ contra contenedor / ◐ contra Render |
| Notificación Slack/Discord | Job `Notify Discord` ([`notify-discord.js`](../scripts/notify-discord.js)). [Evidencia](../evidencias/local/18-notificacion-discord.txt) | ◐ |
| Stryker Mutator | `stryker.config.json`: **86,56 %** ([evidencia](../evidencias/local/11-mutation-stryker.txt)); umbrales 80/60/50 | ✔ |
| Mutation score en el PR | Incluido en el comentario del PR y en el *summary* del job `Mutation tests` | ◐ |
| Paralelización con matrix | Playwright en 2 *shards* + informe fusionado ([evidencia](../evidencias/local/10-e2e-sharding-y-merge-de-informes.txt)); unitarios en 4 versiones de Node | ✔ en local / ◐ en Actions |

## Estructura de archivos esperada

| Esperado | Realidad |
|---|---|
| `.github/workflows/ci.yml`, `cd-staging.yml` | Igual, más la acción compuesta `setup-project` y `dependabot.yml` |
| `src/app.js`, `server.js`, `routes/tasks.js`, `controllers/tasks.controller.js`, `models/task.model.js`, `utils/validators.js` | Igual, más `config.js`, `bootstrap.js`, `db/` y `utils/{errors,logger}.js` |
| `tests/unit/validators.test.js`, `tasks.controller.test.js` | Igual, más otros 16 ficheros unitarios |
| `tests/integration/tasks.api.test.js`, `tests/e2e/tasks.e2e.test.js` | Igual |
| `jest.config.js`, `package.json`, `.eslintrc.json`, `README.md` | `.eslintrc.json` → `eslint.config.js` (errata 2) |

## Funciones puras pedidas

`validateTaskTitle`, `validateTaskPriority`, `sanitizeInput` están en `src/utils/validators.js`; `formatTask`, `filterByStatus`, `sortByPriority`, `calculateStats` en `src/controllers/tasks.controller.js`. Todas con tests propios.

## Checklist final del enunciado

| Punto | Estado |
|---|---|
| Mínimo 10 tests unitarios | ✔ 289 |
| Coverage ≥ 80 % en líneas, funciones y ramas | ✔ 100 % / 98,78 % / 97,74 % |
| Jest falla si baja del umbral | ✔ demostrado |
| CI en cada PR y push a `main` | ◐ |
| Lint y test en paralelo | ◐ |
| Build solo si lint y tests pasan | ◐ (`needs`) |
| Coverage como artefacto | ◐ |
| Branch protection | ◐ |
| README con badge de CI | ✔ (marcador `__GH_OWNER__` pendiente) |
| Integración con PostgreSQL | ✔ local / ◐ Actions |
| Matrix de Node | ✔ |
| Smoke tests post-deploy | ✔ contenedor / ◐ staging |
| Sin secretos en el código | ✔ ver `.env.example` y `.gitignore`; las credenciales de CI/compose son de bases de datos desechables |

## Erratas del enunciado detectadas

1. **`coverageThresholds` (plural) no existe en Jest.** La clave correcta es `coverageThreshold`. Con el plural Jest solo muestra `Unknown option "coverageThresholds"` y sale con código 0, así que el requisito «el pipeline debe fallar si no se alcanza el threshold» **no se cumpliría nunca**. [Demostración](../evidencias/local/07-errata-coverageThresholds-plural-no-falla.txt).
2. **`.eslintrc.json` ya no es compatible con ESLint 10.** ESLint 9 lo dejó obsoleto y la versión 10 solo admite la configuración *flat* (`eslint.config.js`). Se usa esa, con las mismas reglas recomendadas más `eqeqeq`, `prefer-const`, `no-var` y `no-console` en `src/`.
3. **El diagrama de flujo habla de «Node 18 y 20».** Node 18 llegó a fin de vida en abril de 2025 y Node 20 en abril de 2026; se mantienen en la matriz porque lo pide el enunciado y se añaden 22 y 24. Las herramientas de lint, E2E y mutación (ESLint 10, Playwright, Stryker 10) exigen Node 20/22+, por lo que esos jobs usan Node 24.
4. **Los comandos de la caché del enunciado** («cache de `node_modules`») se implementan con precauciones; ver [decisiones](decisiones.md#caché-de-node_modules).
