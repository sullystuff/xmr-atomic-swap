# The web UI and the relay in one image, built from this repository's source.
# Build context: the repository root (see deploy/compose.yaml). Needs BuildKit.
# Built on the machine where this was written with rootless Docker; the UI it produced had the
# tree hash of the recorded snapshot. The context is the working tree: it must be one that compiles.

# ---- build: Rust (for the wasm core) and Node
FROM rust:1.94.1-bookworm AS build
COPY --from=node:22-bookworm-slim /usr/local/ /usr/local/
RUN rustup target add wasm32-unknown-unknown \
 && cargo install wasm-bindgen-cli --version 0.2.130 --locked \
 && npm install --global pnpm@9.15.0
WORKDIR /src
COPY . .
# The same path remapping the release step uses, so the wasm does not carry this image's paths.
RUN (pnpm install --frozen-lockfile || pnpm install --no-frozen-lockfile) \
 && RUSTFLAGS="--remap-path-prefix=/src=/xmrswap --remap-path-prefix=/usr/local/cargo=/cargo" pnpm --filter @xmrswap/core-wasm build \
 && pnpm --filter @xmrswap/web build \
 && pnpm --filter @xmrswap/deploy deploy --prod /app

# ---- run: Node only
FROM node:22-bookworm-slim
COPY --from=build /app /app/deploy
COPY --from=build /src/apps/web/dist /app/ui
COPY --from=build /src/releases /app/releases
ENV XMRSWAP_UI_DIST=/app/ui XMRSWAP_UI_RELEASES=/app/releases
USER node
EXPOSE 8780
WORKDIR /app/deploy
CMD ["node", "--import", "tsx", "src/cli.ts", "start"]
