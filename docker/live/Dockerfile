# Maya-Live staging images (Docker Desktop project `maya-live`, see compose.live.yaml and docs/maya-live/STAGING.md).
# Targets: house-server, admin, game. The paper-demo images in the root Dockerfile are unchanged.

FROM ghcr.io/foundry-rs/foundry:stable AS contracts
USER root
WORKDIR /repo/contracts
# lib/openzeppelin-contracts is a git submodule; it must be checked out before building. contracts/out and cache are
# excluded from the build context (.dockerignore), so the ABIs and bytecode are always compiled fresh from src/.
COPY contracts/ ./
RUN forge build --skip test --skip script

FROM node:24-alpine@sha256:ebfe2f90462722a7a4de65e91990e97fe0d401c70e0e762c5b53302f905ec1c1 AS build
WORKDIR /workspace
RUN npm install --global pnpm@11.25.0
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml turbo.json ./
COPY tooling ./tooling
COPY packages ./packages
COPY apps ./apps
RUN pnpm install --frozen-lockfile
RUN pnpm --filter @maya/house-server... build && pnpm --filter @maya/admin build
# The game: VITE_MAYA_MODE=live boots src/bootstrap-live.ts. The DEV ONLY test wallet is never bundled here:
# VITE_MAYA_TEST_WALLET is pinned to 0 and the build fails if any dev-wallet code reached the bundle.
ARG VITE_MAYA_MODE=live
RUN VITE_MAYA_MODE=${VITE_MAYA_MODE} VITE_MAYA_TEST_WALLET=0 pnpm --filter @maya/demo... build \
 && if find apps/demo/dist -name '*.js' | xargs grep -lE '/v1/dev/wallet|DEV ONLY test wallet'; then echo 'refusing: the DEV ONLY test wallet reached the game bundle' >&2; exit 1; fi
RUN pnpm --filter @maya/house-server deploy --prod --legacy /out/house-server

FROM node:24-alpine@sha256:ebfe2f90462722a7a4de65e91990e97fe0d401c70e0e762c5b53302f905ec1c1 AS house-server
# MAYA_REPO_ROOT=/app: the server and the deploy CLI read contracts/out (ABIs, built above), contracts/deployments
# (<chainId>.json, mounted), .secrets/testnet-wallets.json (mounted at /app/.secrets; MAYA_SECRETS_DIR points there too,
# so the admin token is <secrets>/admin-token) and, in replay mode, the market log at MAYA_MARKET_DATA.
WORKDIR /app
COPY --from=build --chown=node:node /out/house-server ./apps/house-server
COPY --from=contracts --chown=node:node /repo/contracts/out/MockOpenToken.sol ./contracts/out/MockOpenToken.sol
COPY --from=contracts --chown=node:node /repo/contracts/out/MayaHouseVault.sol ./contracts/out/MayaHouseVault.sol
RUN mkdir -p /data /app/.secrets /app/contracts/deployments && chown node:node /data /app/.secrets /app/contracts/deployments
# /data must be persistent (compose: the house-data volume). It holds the journal (journal-<run>.jsonl), the run a
# restart resumes when MAYA_RUN_ID is unset (active-run-<network>.json), the per-run indexer cursor
# (runs/<run>/chain-cursor-<chainId>.json), refitted tables and the attested balance trees. On a live vault with player
# history the server refuses to start an empty journal (FRESH_LEDGER_ON_VAULT_HISTORY); set MAYA_RUN_ID to the owning
# run, or MAYA_ALLOW_FRESH_LEDGER=1 only for a deliberate rebuild from chain events.
USER node
ENV NODE_ENV=production MAYA_REPO_ROOT=/app MAYA_HOST=0.0.0.0 MAYA_ADMIN_PORT=8790 MAYA_DATA_DIR=/data MAYA_SECRETS_DIR=/app/.secrets
EXPOSE 8790
HEALTHCHECK --interval=15s --timeout=4s --start-period=60s --retries=4 CMD node -e "fetch('http://127.0.0.1:8790/v1/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
WORKDIR /app/apps/house-server
CMD ["node", "dist/main.js"]

FROM nginxinc/nginx-unprivileged:alpine@sha256:b54ac358b83fc6c965793fd271839b4ea4cdb6e99895bb19618cbc2ca152d972 AS admin
COPY docker/live/admin-nginx.conf /etc/nginx/nginx.conf
COPY docker/live/security-headers.conf /etc/nginx/maya-security-headers.conf
COPY --from=build /workspace/apps/admin/dist /usr/share/nginx/html
EXPOSE 8080
HEALTHCHECK --interval=20s --timeout=4s --start-period=5s --retries=3 CMD wget -q -O /dev/null http://127.0.0.1:8080/health || exit 1
ENTRYPOINT ["nginx", "-g", "daemon off;"]

FROM nginxinc/nginx-unprivileged:alpine@sha256:b54ac358b83fc6c965793fd271839b4ea4cdb6e99895bb19618cbc2ca152d972 AS game
COPY docker/live/game-nginx.conf /etc/nginx/nginx.conf
COPY docker/live/security-headers.conf /etc/nginx/maya-security-headers.conf
COPY --from=build /workspace/apps/demo/dist /usr/share/nginx/html
EXPOSE 8080
HEALTHCHECK --interval=20s --timeout=4s --start-period=5s --retries=3 CMD wget -q -O /dev/null http://127.0.0.1:8080/health || exit 1
ENTRYPOINT ["nginx", "-g", "daemon off;"]
