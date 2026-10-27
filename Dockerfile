FROM node:24-alpine@sha256:ebfe2f90462722a7a4de65e91990e97fe0d401c70e0e762c5b53302f905ec1c1 AS build
WORKDIR /workspace
RUN npm install --global pnpm@11.25.0
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml turbo.json ./
COPY tooling ./tooling
COPY packages ./packages
COPY apps ./apps
RUN pnpm install --frozen-lockfile
RUN pnpm --filter @maya/demo... build

FROM node:24-alpine@sha256:ebfe2f90462722a7a4de65e91990e97fe0d401c70e0e762c5b53302f905ec1c1 AS feed-relay
WORKDIR /app
COPY --chown=node:node apps/feed-relay/src ./src
COPY --chown=node:node apps/feed-relay/data ./data
USER node
ENV PORT=8787 FEED_SOURCE=replay
EXPOSE 8787
HEALTHCHECK --interval=20s --timeout=4s --start-period=5s --retries=3 CMD node -e "fetch('http://127.0.0.1:8787/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "src/server.mjs"]

FROM node:24-alpine@sha256:ebfe2f90462722a7a4de65e91990e97fe0d401c70e0e762c5b53302f905ec1c1 AS recorder
WORKDIR /app
# The four workspace packages have no third-party runtime dependencies, so their
# built output is placed straight into node_modules.
COPY --from=build /workspace/packages/contracts/package.json ./node_modules/@maya/contracts/package.json
COPY --from=build /workspace/packages/contracts/dist ./node_modules/@maya/contracts/dist
COPY --from=build /workspace/packages/config/package.json ./node_modules/@maya/config/package.json
COPY --from=build /workspace/packages/config/dist ./node_modules/@maya/config/dist
COPY --from=build /workspace/packages/market-data/package.json ./node_modules/@maya/market-data/package.json
COPY --from=build /workspace/packages/market-data/dist ./node_modules/@maya/market-data/dist
COPY --from=build /workspace/packages/pricing/package.json ./node_modules/@maya/pricing/package.json
COPY --from=build /workspace/packages/pricing/dist ./node_modules/@maya/pricing/dist
COPY apps/recorder/package.json ./package.json
COPY apps/recorder/src ./src
RUN mkdir /data && chown node:node /data
USER node
ENV MARKET_LOG_DIR=/data
VOLUME /data
HEALTHCHECK --interval=30s --timeout=4s --start-period=20s --retries=3 CMD node -e "process.exit(Date.now()-require('node:fs').statSync('/data/.heartbeat').mtimeMs<90000?0:1)"
CMD ["node", "src/main.mjs"]

FROM nginxinc/nginx-unprivileged:alpine@sha256:b54ac358b83fc6c965793fd271839b4ea4cdb6e99895bb19618cbc2ca152d972 AS web
COPY docker/nginx.conf /etc/nginx/nginx.conf
COPY --from=build /workspace/apps/demo/dist /usr/share/nginx/html
EXPOSE 8080
HEALTHCHECK --interval=20s --timeout=4s --start-period=5s --retries=3 CMD wget -q -O /dev/null http://127.0.0.1:8080/health || exit 1
ENTRYPOINT ["nginx", "-g", "daemon off;"]
