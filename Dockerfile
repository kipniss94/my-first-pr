# ---------------------------------------------------------------------------
# DocuView — one image that runs both services.
#
# Kept as a single image on purpose: the processing layer shells out to
# LibreOffice, so the API needs it installed anyway, and a single container is
# the shortest path from `docker compose up` to a working viewer.
# ---------------------------------------------------------------------------
FROM node:22-slim AS deps

WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
RUN npm ci --no-audit --no-fund

# ---------------------------------------------------------------------------

FROM deps AS build

COPY tsconfig.base.json ./
COPY packages ./packages
COPY apps ./apps
COPY scripts ./scripts
RUN npm run build

# Drop development dependencies from the runtime tree.
RUN npm prune --omit=dev

# ---------------------------------------------------------------------------

FROM node:22-slim AS runtime

# LibreOffice is what makes DOC, PPT, XLS, OpenDocument and the exact page
# layout work. `libreoffice-core` alone is not enough — without the filter
# packages every conversion fails with "source file could not be loaded".
RUN apt-get update \
 && apt-get install --no-install-recommends -y \
      libreoffice-writer \
      libreoffice-calc \
      libreoffice-impress \
      fonts-liberation \
      fonts-dejavu-core \
      ca-certificates \
 && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production \
    API_PORT=4000 \
    API_HOST=0.0.0.0 \
    API_INTERNAL_URL=http://127.0.0.1:4000 \
    DATA_DIR=/data \
    PRETTY_LOGS=false

WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/packages ./packages
COPY --from=build /app/apps/api/package.json ./apps/api/package.json
COPY --from=build /app/apps/api/dist ./apps/api/dist
COPY --from=build /app/apps/web ./apps/web
COPY --from=build /app/scripts ./scripts

# Uploads live outside the image so a restart never resurrects a deleted file.
VOLUME ["/data"]
RUN mkdir -p /data && chown -R node:node /data /app
USER node

EXPOSE 3000 4000

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s \
  CMD node -e "fetch('http://127.0.0.1:4000/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# Both services in one container, so a crash in either takes the container down
# and the orchestrator restarts a known-good state.
CMD ["npm", "start"]
