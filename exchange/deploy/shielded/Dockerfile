ARG RUST_IMAGE=rust:1.95.0-slim-bookworm@sha256:d7482085ff5b415f84dba5647ae71606650bdef00db7aeb69f4b3d170c3e4082
ARG NODE_IMAGE=node:22.23.5-bookworm-slim@sha256:e9f565d32859f0cbfb52125eafe8be39390f24dac302dc3cdf566e8ba3ab21ee

FROM ${RUST_IMAGE} AS prover
WORKDIR /prover
COPY prover/ ./
COPY src/pool_poseidon.rs /src/pool_poseidon.rs
RUN cargo build --release --locked --bin quiet-pool-prover

FROM ${NODE_IMAGE}
WORKDIR /app
COPY package.json package-lock.json ./
COPY exchange/package.json exchange/package-lock.json exchange/
RUN npm ci --ignore-scripts --no-audit --no-fund \
 && npm ci --prefix exchange --ignore-scripts --no-audit --no-fund
COPY exchange/index.html exchange/vite.config.js exchange/
COPY exchange/src exchange/src
COPY exchange/public exchange/public
RUN npm run build --prefix exchange
COPY exchange/server exchange/server
COPY scripts/testnet-client.mjs scripts/shielded-pool-operator.mjs scripts/
COPY exchange/deploy/shielded/launch.mjs ./launch.mjs
COPY --from=prover /prover/target/release/quiet-pool-prover /app/bin/quiet-pool-prover
COPY artifacts/liquidation.pk /app/artifacts/liquidation.pk
CMD ["node", "launch.mjs"]
