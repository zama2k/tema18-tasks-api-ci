# syntax=docker/dockerfile:1

# ---- Stage 1: production dependencies only (no dev tooling ends up in the image) ----
FROM node:24.12.0-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN --mount=type=cache,target=/root/.npm \
    npm ci --omit=dev --ignore-scripts

# ---- Stage 2: runtime ----
FROM node:24.12.0-alpine AS runtime
WORKDIR /app

ENV NODE_ENV=production \
    PORT=3000

COPY --from=deps --chown=node:node /app/node_modules ./node_modules
COPY --chown=node:node package.json ./
COPY --chown=node:node src ./src
COPY --chown=node:node public ./public
COPY --chown=node:node scripts/healthcheck.js ./scripts/healthcheck.js

# Declared late so a new commit only invalidates the layers below this line.
# The commit is baked in: the exact same image is promoted from staging to production.
ARG GIT_SHA=unknown
ENV GIT_SHA=${GIT_SHA}

USER node
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD ["node", "scripts/healthcheck.js"]

# Exec form and no npm wrapper: node is PID 1 and receives SIGTERM directly,
# which is what makes the graceful shutdown in src/bootstrap.js work.
CMD ["node", "src/server.js"]
