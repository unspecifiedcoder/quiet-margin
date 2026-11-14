# Hosted Shielded Pool testnet demo

The Fly configuration runs the judge API, live price publisher, and keeper
processes on one machine. Its `/data` volume preserves faucet claims across
restarts. The two live keeper processes share a failure domain. The controlled
pool runs Keeper B and uses manually published test marks.

Stage the image from a Git archive containing the tracked `exchange/`,
`prover/`, `src/pool_poseidon.rs`, root Node manifests, and the two scripts
referenced by the [Dockerfile](Dockerfile). Add the matching public
`artifacts/liquidation.pk` and copy the Fly config to the staging root. The
proving key must match the deployed pool verifier. Keep wallet files, witnesses
and the rest of `.testnet/` outside the build context.

Import the testnet sponsor ID and key as `QUIET_POOL_SPONSOR_ID` and
`QUIET_POOL_SPONSOR_KEY`. Import the base64-encoded keeper JSON and an operator
dotenv containing only the oracle and keeper roles as `QUIET_KEEPER_FILE_B64`
and `QUIET_OPERATOR_FILE_B64`. Fly mounts those files at runtime.

Deploy the frontend with the [Vercel routing configuration](vercel.json)
alongside the built `dist/` directory. It forwards `/api` requests to Fly.
The configured HTTPS origin determines the private trading key derivation.
