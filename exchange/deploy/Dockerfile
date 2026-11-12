# syntax=docker/dockerfile:1
#
# Hosted Xythum testnet session coordinator (Fly.io). Build ONLY from the
# sanitized context written by exchange/deploy/stage.mjs, never from a
# working tree: that context holds exact tracked files at one Git commit plus
# the hash-pinned PUBLIC artifacts, and no .env, session, keeper or witness
# file. No secret is passed to, or baked into, this image; role secrets
# arrive at runtime as Fly secrets.
#
# Base images: official tags pinned to their multi-arch index digests
# (Docker Hub, looked up 2026-11-12). Re-check with
#   docker buildx imagetools inspect <tag>
ARG RUST_IMAGE=rust:1.95.0-slim-bookworm@sha256:d7482085ff5b415f84dba5647ae71606650bdef00db7aeb69f4b3d170c3e4082
ARG NODE_IMAGE=node:22.23.5-bookworm-slim@sha256:e9f565d32859f0cbfb52125eafe8be39390f24dac302dc3cdf566e8ba3ab21ee

# ---- Linux native prover: locked Rust 1.95.0 --------------------------------
FROM ${RUST_IMAGE} AS prover
ENV CARGO_TERM_COLOR=never CARGO_INCREMENTAL=0
WORKDIR /src/prover
COPY prover/ ./
# rust-toolchain.toml is deliberately not staged (it would pull wasm32 and
# clippy); assert the image toolchain is exactly the repository's 1.95.0.
RUN rustc --version | grep -Eq '^rustc 1\.95\.0 ' \
 && cargo build --release --locked --bin xythum-prover \
 && install -D -m 0755 target/release/xythum-prover /out/xythum-prover

# ---- Node dependencies: npm ci with install scripts disabled ----------------
# --ignore-scripts keeps near-workspaces/near-sandbox (custom-RPC mode only),
# secp256k1 and esbuild lifecycle scripts from running.
FROM ${NODE_IMAGE} AS deps
ENV npm_config_audit=false npm_config_fund=false npm_config_update_notifier=false
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts --no-audit --no-fund
COPY exchange/package.json exchange/package-lock.json exchange/
RUN cd exchange && npm ci --ignore-scripts --no-audit --no-fund

# ---- Browser bundle (Vite) ---------------------------------------------------
FROM deps AS web
COPY exchange/index.html exchange/vite.config.js exchange/
COPY exchange/src exchange/src
COPY exchange/public exchange/public
RUN cd exchange && npm run build

# ---- Runtime -----------------------------------------------------------------
FROM ${NODE_IMAGE} AS runtime
ENV NODE_ENV=production \
    XYTHUM_ALLOW_HOSTED=1 \
    XYTHUM_SERVER_HOST=0.0.0.0 \
    XYTHUM_SERVER_PORT=8080 \
    XYTHUM_SESSION_DIR=/data/sessions \
    XYTHUM_PROVING_DIR=/app/artifacts/proving \
    MARKET_WASM=/app/artifacts/market.wasm \
    XYTHUM_MARKET_WASM_SHA256=9004770854c3d3a1aa8c71d7a19d258fac568abb41cda1dd2ad1827b5c80db7c \
    PROVER_BIN=/app/bin/xythum-prover \
    XYTHUM_SESSION_QUOTA=0
RUN groupadd --system --gid 10001 xythum \
 && useradd --system --uid 10001 --gid 10001 --no-create-home --home-dir /nonexistent --shell /usr/sbin/nologin xythum
WORKDIR /app
# Root-owned, world-readable code: the app user cannot modify it.
COPY --from=deps /app/node_modules node_modules
COPY package.json LICENSE ./
COPY scripts/testnet-client.mjs scripts/
COPY tests/actor.mjs tests/
COPY exchange/package.json exchange/
COPY exchange/server exchange/server
COPY exchange/deploy/artifacts.lock.json exchange/deploy/
COPY exchange/deploy/runtime exchange/deploy/runtime
COPY --from=web /app/exchange/dist exchange/dist
COPY --from=prover /out/xythum-prover bin/xythum-prover
COPY artifacts artifacts
RUN chmod -R a+rX,go-w /app && chmod 0755 /app/bin/xythum-prover
# Offline check as the app user, no secrets, no network: pinned artifacts at
# their runtime paths (the browser prover files only exist under
# exchange/dist here), the Linux prover (empty child env) re-derives the
# pinned verifying keys, the real createApp refuses missing/wrong invites
# before a stub coordinator, and the server's hosted credential loader scrubs.
USER xythum
RUN node exchange/deploy/runtime/launch.mjs --self-check
# The entrypoint starts as root only to create and chown /data/sessions on the
# (root-owned) Fly volume, then permanently drops to uid 10001 before any
# server code is loaded. See runtime/launch.mjs.
USER root
EXPOSE 8080
ENTRYPOINT ["node", "/app/exchange/deploy/runtime/launch.mjs"]
