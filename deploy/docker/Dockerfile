# The web UI and the relay in one image, built from this repository's source.
# NOT BUILT on the machine where this was written (it has no Docker).
# Build context: the repository root (see deploy/compose.yaml).

# ---- build: Rust (for the wasm core) and Node
FROM rust:1.94.1-bookworm AS build
COPY --from=node:22-bookworm-slim /usr/local/ /usr/local/
RUN rustup target add wasm32-unknown-unknown \
 && cargo install wasm-bindgen-cli --version 0.2.130 --locked \
 && npm install --global pnpm@9.15.0
WORKDIR /src
COPY . .
RUN pnpm install --no-frozen-lockfile \
 && pnpm --filter @xmrswap/web build \
 && pnpm --filter @xmrswap/deploy run release /release \
 && node deploy/scripts/verify.mjs /release

# ---- run: Node only
FROM node:22-bookworm-slim
RUN npm install --global pnpm@9.15.0
WORKDIR /app
ENV CI=true
COPY --from=build /src/package.json /src/pnpm-workspace.yaml /src/pnpm-lock.yaml /src/tsconfig.base.json ./
COPY --from=build /src/packages/protocol ./packages/protocol
COPY --from=build /src/packages/relay ./packages/relay
COPY --from=build /src/deploy ./deploy
COPY --from=build /release/web /ui
# Only what the bundle needs. The packages were compiled in the build stage, so their install scripts are skipped.
RUN pnpm install --no-frozen-lockfile --ignore-scripts --filter @xmrswap/deploy... \
 && pnpm store prune
ENV XMRSWAP_UI_DIST=/ui
USER node
EXPOSE 8780
WORKDIR /app/deploy
CMD ["node", "--import", "tsx", "src/cli.ts", "start"]
