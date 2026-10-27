# Evidencias de las verificaciones locales

Salidas reales (texto plano, sin colores ANSI y con la ruta del proyecto sustituida por `<repo>`) generadas durante la construcción del repositorio. Entorno: Windows 11, Git Bash, Node 24.12 / npm 11.6, Docker 29.8, PostgreSQL 16 en contenedor. Cada fichero empieza con el comando ejecutado y termina con su código de salida (`[exit code: N]`; en los que encadenan varios comandos, cada `exit=` es el de su comando).

| Fichero | Qué demuestra |
|---|---|
| `01-npm-ci-instalacion-limpia` | `npm ci` desde cero con el lockfile y árbol de dependencias |
| `02-lint` | ESLint sin errores |
| `03-tests-unitarios-cobertura` | 317 tests unitarios con el umbral del 80 % superado |
| `04-tests-integracion-postgres` | 27 tests contra PostgreSQL real, incluidas migraciones y el proceso `server.js` |
| `05-npm-test-completo-con-umbral` | `npm test`: unitarios + integración con cobertura combinada |
| `06-umbral-cobertura-falla-de-verdad` | Con un módulo sin tests, Jest sale con código 1 |
| `07-errata-coverageThresholds-plural-no-falla` | Con la clave del enunciado (plural), Jest ignora el umbral y sale con 0 |
| `08-e2e-playwright-postgres` | 13 tests E2E (UI y API) contra la app real con PostgreSQL |
| `09-e2e-artefactos-en-fallo` | Un fallo forzado conserva captura, vídeo y *trace* |
| `10-e2e-sharding-y-merge-de-informes` | Dos shards (7 + 6 tests) y fusión de los *blob reports* en un HTML |
| `11-mutation-stryker` | Puntuación de mutación real (86,56 %) con el detalle de supervivientes |
| `12-docker-build` | Build multi-stage sin caché; tamaño, usuario, `HEALTHCHECK` y `CMD` |
| `13-docker-verificar-imagen` | `verify-image.sh`: sano, commit correcto, no root, parada ordenada con código 0 |
| `14-docker-contenido-de-la-imagen` | Solo dependencias de producción dentro de la imagen |
| `15-smoke-contra-contenedor-con-postgres` | `smoke.js` contra el contenedor con PostgreSQL (12/12) y contra una URL caída |
| `16-wait-for-health` | Health check con commit esperado, commit distinto y servicio inexistente |
| `17-render-deploy-contra-servidor-falso` | `render-deploy.js` contra el servidor falso: éxito, `202 Queued` (despliegue localizado en el listado), imagen sin digest, clave errónea y secretos ausentes |
| `18-notificacion-discord` | Omisión con aviso sin secreto, rechazo de URL no válida y payload del embed |
| `19-actionlint` | `actionlint` 1.7.12 sin avisos en workflows y acción compuesta |
| `20-shellcheck` | `shellcheck` v0.11.0 (el del CI) y v0.9.0 (el de `ubuntu-latest`) sin avisos en los `.sh`; el fichero indica la versión de cada ejecución |
| `21-matriz-node-18-20-22-24-linux` | Unitarios en verde en Node 18, 20, 22 y 24 en contenedores Linux limpios |
| `22-build-check` | `npm run build` |
| `23-informe-pr-y-badges` | Comentario del PR y JSON de badges generados con datos reales |
| `24-setup-github-dry-run-y-test-con-gh-falso` | `setup-github.sh --dry-run` y su test con `gh` simulado |
| `25-publicacion-de-badges-rama-badges` | `publish-badges.sh` contra un remoto local: creación, idempotencia y actualización |
| `26-docker-compose-config` | `docker-compose.yml` válido (servicios y perfil `app`) |

Esta carpeta contiene solo las comprobaciones locales. Las ejecuciones reales en GitHub Actions y Render están en [`../github/README.md`](../github/README.md). La recepción de los mensajes de Discord no la hemos verificado.
