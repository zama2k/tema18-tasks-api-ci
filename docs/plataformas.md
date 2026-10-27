# Plataformas externas

Documentación consultada el **2026-10-27**. Si una API cambia, el primer sitio a revisar son `scripts/render-deploy.js` y `scripts/notify-discord.js`.

## Render (API de despliegue por imagen)

Fuentes:

- List deploys: <https://api-docs.render.com/reference/list-deploys>
- Trigger Deploy: <https://api-docs.render.com/reference/create-deploy>
- Retrieve Deploy: <https://api-docs.render.com/reference/retrieve-deploy>

| Dato | Valor documentado |
|---|---|
| Autenticación | `Authorization: Bearer <API key>` |
| Lanzar despliegue | `POST https://api.render.com/v1/services/{serviceId}/deploys`, cuerpo `{"imageUrl": "<imagen>"}` → `201` con el objeto *deploy* (`id`, `status`, `image`, …). También `202` (sin esquema documentado) |
| Consultar | `GET https://api.render.com/v1/services/{serviceId}/deploys/{deployId}` |
| Listar | `GET https://api.render.com/v1/services/{serviceId}/deploys?limit=20` (`limit` 1-100, por defecto 20; también `createdAfter`, `status`, `cursor`) → array de `{deploy, cursor}`; `deploy.image` trae `ref` y `sha`, y `deploy.createdAt` la fecha |
| Estados | `created`, `queued`, `build_in_progress`, `update_in_progress`, `pre_deploy_in_progress`, `live`, `deactivated`, `build_failed`, `update_failed`, `pre_deploy_failed`, `canceled` |
| Restricción de `imageUrl` | Para servicios basados en imagen; «host, repository and image name must match» la imagen configurada en el servicio. No se puede combinar con `commitId`, `buildId` ni `deployMode: deploy_only` |
| Errores | `400, 401, 404, 406, 409, 410, 429, 500, 503` con `{id, message}`; el `429` trae `Retry-After` |

Cómo lo usa el script ([`render-deploy.js`](../scripts/render-deploy.js)):

- Éxito = `live`. Fallo = `build_failed`, `update_failed`, `pre_deploy_failed`, `canceled` o `deactivated` (reemplazado por un despliegue más nuevo). Un estado desconocido también es error, para no sondear eternamente.
- Reintenta el `POST` solo ante `429`/`503` (un despliegue duplicado de la misma imagen sería inofensivo, pero no hace falta), y tolera hasta 5 fallos consecutivos de red/5xx al sondear.
- Ante un `202 Queued` (sin cuerpo según la documentación) lista los 20 despliegues más recientes y elige el más nuevo cuya imagen coincide con el digest pedido (normalizando `sha256:` y mayúsculas, mirando `image.sha` e `image.ref`) y cuya `createdAt` es posterior a la petición menos 2 minutos de tolerancia de reloj; reintenta hasta 8 veces cada 5 s y nunca usa `limit=1`. Si no aparece, falla con un mensaje explícito. Un fallo al listar nunca vuelve a lanzar el `POST`.
- La clave de API nunca se imprime: se elimina de cualquier mensaje.

### Preparar el servicio en Render

1. *New → Web Service → Existing image*: `ghcr.io/<usuario>/tema18-tasks-api-ci:main` (el repositorio e imagen deben coincidir con los que usa el CD; el *tag* inicial da igual porque se despliega por digest).
2. *Health Check Path*: `/health`. Render inyecta `PORT`; la app lo lee.
3. Opcional: crear una base PostgreSQL de Render y enlazar `DATABASE_URL`; añadir `AUTO_MIGRATE=true` para aplicar las migraciones al arrancar. Sin `DATABASE_URL` la app usa memoria (`/health.storage` lo indica) y los datos se pierden al reiniciar.
4. Si el paquete de GHCR es privado, añadir credenciales de registro (usuario + *Personal Access Token* con `read:packages`) en *Settings → Registry Credentials*; si no, ponerlo en **público** desde la configuración del paquete (los paquetes nuevos nacen privados aunque el repo sea público).
5. Copiar el *Service ID* (`srv-...`) → variable `RENDER_SERVICE_ID`; crear una API key en *Account Settings → API Keys* → secreto `RENDER_API_KEY`.

## Discord (webhook entrante)

Fuentes:

- Execute Webhook: <https://docs.discord.com/developers/resources/webhook>
- Embed object y límites: <https://docs.discord.com/developers/resources/message>

| Dato | Valor documentado |
|---|---|
| Petición | `POST /webhooks/{webhook.id}/{webhook.token}` con JSON; sin autenticación adicional |
| Respuesta | `204 No Content` (sin `?wait=true`) |
| Cuerpo | Al menos uno de `content`, `embeds`, …; `embeds` hasta 10; `username` opcional |
| Límites de un embed | título 256, descripción 4096, hasta 25 campos, nombre de campo 256, valor de campo 1024, 6000 caracteres en total |

El script valida que la URL sea `https://discord.com/api/webhooks/<id>/<token>` (o `discordapp.com`/`canary`/`ptb`), de modo que un secreto mal configurado no envíe datos a otro host. Un `429` se reintenta una vez respetando `retry_after`. Cualquier otro fallo se emite como `::warning::` y no rompe el pipeline. La documentación consultada no detalla el formato del `429`; el campo `retry_after` se ha tomado de la práctica habitual de la API y debe confirmarse en el primer fallo real (con valor por defecto de 1 s si no existe).

## GitHub Container Registry

- Imagen: `ghcr.io/<owner>/<repo>` en minúsculas (lo garantiza `docker/metadata-action`). Etiquetas: `sha-<sha completo>` y `main`.
- La etiqueta `org.opencontainers.image.source` (la añade `metadata-action`) vincula el paquete al repositorio, de modo que `GITHUB_TOKEN` con `packages: write` puede publicar.
- El CD y Render usan el **digest**, no las etiquetas.

## Acciones fijadas (todas por SHA, versión en el comentario)

| Acción | Versión | SHA |
|---|---|---|
| actions/checkout | v7.0.1 | `3d3c42e5aac5ba805825da76410c181273ba90b1` |
| actions/setup-node | v7.1.0 | `949feb2413d6458794dcd2491c4babbbce0c15c1` |
| actions/cache | v6.1.0 | `55cc8345863c7cc4c66a329aec7e433d2d1c52a9` |
| actions/upload-artifact | v7.0.2 | `cf430e030ddbb5b0abf93d22962f4752f3646cd9` |
| actions/download-artifact | v8.0.2 | `9000827ccba6bdab643e8b6fd33ac0654aef8333` |
| actions/github-script | v9.0.0 | `3a2844b7e9c422d3c10d287c895573f7108da1b3` |
| docker/setup-buildx-action | v4.4.1 | `f87e5991a6d7451dcb8d9637bfbc97413f497069` |
| docker/build-push-action | v7.4.0 | `c3c9e263c25d99ce0380d002d59b67737d91b0dc` |
| docker/login-action | v4.7.0 | `81c6f93d4bc991e510b342a00b419b3bb4efc5c6` |
| docker/metadata-action | v6.2.0 | `dc802804100637a589fabce1cb79ff13a1411302` |
| codecov/codecov-action | v7.1.1 | `303a32d7a59b442fa8d48b6a1cc6825c09c847a5` |

Cada SHA se obtuvo con `git ls-remote --tags` (etiqueta *peeled* `^{}` cuando es anotada) y se comprobó que el `action.yml` de ese commit declara `using: node24` (o `composite` en Codecov) y los *inputs* usados. Imágenes de contenedor fijadas por versión: `rhysd/actionlint:1.7.12`, `koalaman/shellcheck:v0.11.0`, `postgres:16-alpine`, `node:24.12.0-alpine`.
