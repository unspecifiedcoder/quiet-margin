# Hosting the testnet session coordinator on Fly.io

This is the package for running `exchange/server` (the testnet session
coordinator plus the built exchange UI) as one always-on Fly Machine. It lives
in `exchange/deploy/`. **Nothing here has been deployed, and the Linux image
has never been built.** Every command that creates Fly resources or uploads
anything is in the "Paid launch" section and needs the owner's explicit
approval first.

| Piece | Choice |
| --- | --- |
| App | a **new** dedicated Fly app (`--app <name>`); never reuse an existing one |
| Machine | exactly 1 × `shared-cpu-2x`, 2 GB, region `iad`, always on (`auto_stop_machines = "off"`, `min_machines_running = 1`, no autoscaling), deployed with `--ha=false` |
| Storage | exactly 1 volume, 1 GB `xythum_sessions` at `/data`; sessions in `/data/sessions` |
| HTTP | `force_https`, internal port 8080, health check `GET /api/health` |
| IPs | shared IPv4 + IPv6 (no dedicated IPv4) |
| Funded sessions | `XYTHUM_SESSION_QUOTA = "1"`: exactly one remotely funded session |
| Admission | `POST /api/sessions` requires the private invite (server-side gate, see below) |
| Cost | public quote **about $13.54 per 30 days, plus usage** (bandwidth, builder, snapshots) |

## Private repository vs. what the hosted site makes public

The repository can stay private; the hosted site does not. Keep these apart:

- **Served publicly by the running app** (anyone with the URL, no invite):
  the built browser bundle (`exchange/dist`, compiled from `exchange/src`),
  the browser prover Wasm/glue, the open and close proving keys
  (`/api/proving/*.pk`), and `GET /api/health`. Treat everything in
  `exchange/src` as published once deployed.
- **Uploaded to Fly but not served:** the whole staging context (about
  205 MB) goes to Fly's remote builder with `fly deploy --remote-only`. That
  includes the server, prover and script sources at the staged commit and the
  liquidation proving key and market Wasm. They are in the image, not on any
  route.
- **Never in the context, the image or the logs:** `.env`, role or keeper
  secrets, the invite, session records, witnesses, `.vk` files, `.git`.
  Secrets reach the Machine only as Fly secrets at runtime.

## What is in the image (and what is not)

`exchange/deploy/stage.mjs` writes the build context. It never uploads.

- **Tracked code at one commit.** It extracts a `git archive <commit>` of an
  explicit allowlist: root and `exchange/` `package.json`/lockfiles,
  `exchange/{index.html,vite.config.js,src,server}` (tests excluded),
  `scripts/testnet-client.mjs`, `tests/actor.mjs`, `prover/` (Cargo manifest,
  lockfile, `src/`, `browser/keys.rs`) and `exchange/deploy/` (Dockerfile,
  fly.toml, lock, `runtime/launch.mjs`, `runtime/invite-smoke.mjs`). The
  archive must contain exactly that list. A missing or extra entry, a symlink
  or a special file fails the stage.
- **Pinned public artifacts only.** The seven paths in
  `exchange/deploy/artifacts.lock.json` are copied from `--source` by exact
  path and size/SHA-256-checked before and after the copy. Nothing else under
  `--source` is opened or listed.

  | Artifact | Source path | SHA-256 |
  | --- | --- | --- |
  | Market Wasm (recorded clearing Wasm) | `target/near/xythum_near_perps.wasm` | `90047708…80db7c` |
  | Open proving key | `.testnet/proving/open.pk` | `7493ceba…84010f` |
  | Close proving key | `.testnet/proving/close.pk` | `26df7dc7…82a58a` |
  | Liquidation proving key | `.testnet/proving/liquidation.pk` | `cfde7123…5643a8` |
  | Browser prover glue / Wasm / snippet | `exchange/public/prover/…` (generated, Git-ignored) | see lock |

  The stage also checks that the pins agree with the repository: the Wasm
  with `docs/TESTNET-ADDRESSES.md`, the open/close keys with
  `exchange/src/protocol/prover-pins.js`, the verifying-key fingerprints with
  `PINNED_VK_FINGERPRINTS`, and Rust 1.95.0 with `rust-toolchain.toml`.
- **Invite gate, checked by behavior.** The stage runs
  `runtime/invite-smoke.mjs` on the staged server code in a child process
  with an empty environment (only `SystemRoot` on Windows). It uses the real
  `createApp` and `loadConfig` with a stub coordinator, no RPC and no
  credentials. It requires that hosted config refuses to load without a valid
  invite, and that `POST /api/sessions` with a missing, empty, uppercase,
  short, wrong or bearer-only invite gets `401 invite_required` without
  reaching the coordinator, while the correct invite does reach it. The image
  self-check runs the same file.
- **Never in the context or the image:** `.env`, session records, keeper
  files, witnesses, `.vk`, `node_modules`, `target`, or `.git`. A final scan
  fails the stage on any such path, on unpinned `.pk` files, and on
  secret-looking text (NEAR secret keys, PEM private keys, assigned
  `NEAR_*SECRET*` values, invite values or links).
- **Atomic replacement.** The context is built in a scratch directory next to
  `--out` and moved over `--out` only after every check passed. If anything
  fails, the scratch directory is deleted and an earlier context at `--out`
  is left exactly as it was.

The Dockerfile (Linux, multi-stage; **not built yet**, see Verification):

1. `rust:1.95.0-slim-bookworm` (pinned by digest). It asserts `rustc 1.95.0`
   and runs `cargo build --release --locked --bin xythum-prover`.
2. `node:22.23.5-bookworm-slim` (pinned by digest). It runs
   `npm ci --ignore-scripts` for the root and for `exchange/`, so no
   lifecycle script runs (`near-workspaces`/`near-sandbox`, `secp256k1`,
   `esbuild`). Then `npm run build` produces `exchange/dist`, which includes
   the browser prover files from `exchange/public/prover`.
3. Runtime: root-owned, read-only code under `/app`, the prover at
   `/app/bin/xythum-prover`, artifacts under `/app/artifacts`, and
   `exchange/dist`. `exchange/public` is **not** copied. As uid 10001 the build
   runs `launch.mjs --self-check`, which:
   - re-hashes each pinned artifact at its runtime path (the `dist` copy for
     the three browser prover files, `artifacts/…` for the rest);
   - runs the Linux prover with an empty environment and compares the
     re-derived open/close/liquidation verifying keys with the pins;
   - runs the invite smoke check against the image's `exchange/server`;
   - calls the server's `takeCredentials` with a synthetic incomplete hosted
     environment and requires it to refuse and scrub every secret variable;
   - requires that no `.env` is present.

## Runtime and secrets

The fixed runtime values are in `fly.toml` `[env]`, and the launcher requires
them exactly: `XYTHUM_ALLOW_HOSTED=1`, `XYTHUM_SERVER_HOST=0.0.0.0`,
`XYTHUM_SERVER_PORT=8080`, `XYTHUM_SESSION_DIR=/data/sessions`,
`XYTHUM_PROVING_DIR=/app/artifacts/proving`,
`MARKET_WASM=/app/artifacts/market.wasm`, `PROVER_BIN=/app/bin/xythum-prover`,
`XYTHUM_MARKET_WASM_SHA256=<locked>`, and `XYTHUM_SESSION_QUOTA` of 0 or 1.

**Credentials are handled by the server, not the launcher.** At startup
`exchange/server/server.mjs` requires `XYTHUM_HOSTED_INVITE` (64 lowercase
hex) and loads the hosted roles with `loadHostedEnv` from
`scripts/testnet-client.mjs`: from runtime variables, or from one mounted
KEY=VALUE file named by `XYTHUM_CREDENTIALS_FILE` (absolute, outside `/app`).
It then deletes every secret variable and the invite from `process.env`
(also when loading fails) before any child process starts. The launcher does
not read, validate or require any credential variable, so both delivery
modes work.

`exchange/deploy/secrets.mjs` builds the credentials from a source env file
using the server's own schema (`HOSTED_VARIABLES`, `HOSTED_UNUSED_SECRETS`,
`loadHostedEnv`, `INVITE_PATTERN`) and validates the written text after a
parse round trip:

- `NEAR_NETWORK_ID`, `NEAR_RPC_URL`
- `NEAR_<ROLE>_ACCOUNT_ID` for all eight roles
- `NEAR_<ROLE>_SECRET_KEY` and `NEAR_<ROLE>_PUBLIC_KEY` **only** for the
  signers `DEMO`, `MARKET` (the session-market deploy key), `MAKER`, `ORACLE`
  and `KEEPER_B`
- `NEAR_<ROLE>_PUBLIC_KEY` for `TOKEN`, `TRADER`, `KEEPER_A` when present
  (optional for the server)
- both keepers' `ACK_PUBLIC`/`ACK_SECRET` and `ENCRYPTION_PUBLIC`/`ENCRYPTION_SECRET`
- `XYTHUM_HOSTED_INVITE`, freshly generated (32 random bytes)

The `TOKEN`, `TRADER` and `KEEPER_A` transaction secrets are never copied
(the server refuses them if set), nor is anything else from the source file
(for example `NEAR_DEPLOYMENT_ID`, which the hosted loader does not read).

Boot sequence (`runtime/launch.mjs`, Linux only):

1. Starting as root, it requires `/data` to be a mounted volume, so sessions
   and the quota count are never on the ephemeral root filesystem. It creates
   `/data/sessions` with mode 0700, chowns it to uid 10001, and drops
   privileges permanently (`setgroups`/`setgid`/`setuid`, then checks that
   root cannot be regained). No server code is loaded as root.
2. It checks the runtime values and the quota cap, and re-hashes the pinned
   artifacts at their runtime paths.
3. It removes a `coordinator.lock` on the volume unless it names a live
   coordinator process on this Machine. This only covers restarts of the same
   Machine; it is not a guard against a second Machine (see below).
4. It loads `exchange/server/server.mjs` unmodified. The server loads and
   scrubs the credentials, re-derives and pins the verifying keys (the
   prover child gets only the minimal child environment), connects to
   testnet, and listens on `0.0.0.0:8080`.

### Invite gate

The gate on `POST /api/sessions` is implemented in `exchange/server/app.mjs`
and the browser client (`#invite=<64 hex>` link fragment, sent as the
`X-Xythum-Invite` header). Fragments are not sent in HTTP requests, so the
invite never appears in proxy request lines. Hosted mode refuses to start
without a valid invite. This package proves the gate's behavior offline at
stage time and in the image self-check; it does not implement it.

## Steps

All of these run from this repository's root on Windows (PowerShell or Git
Bash). `<app>` is the new app name, for example `xythum-perps-testnet-<suffix>`.
Fly app names are global, so `fly apps create` fails instead of reusing a
name that is taken.

### 1. Offline checks (free)

```text
node --test exchange/deploy/test/deploy.test.mjs exchange/deploy/test/secrets.test.mjs
```

`secrets.test.mjs` uses the server's credential loader and is skipped unless
the root dependencies are installed (`npm ci --ignore-scripts`).

### 2. Stage the build context (free, local)

Stage the integrated commit that contains `exchange/deploy/` and the server
invite gate (normally `HEAD` once the package is committed). The public
artifacts come from the verified worktree:

```text
node exchange/deploy/stage.mjs --ref HEAD --source E:\github2\perp\xythum-near-perps --app <app>
```

The output goes to `target/fly-stage/`, which is Git-ignored. `--out` must be
Git-ignored or outside the repositories, and is replaced only if an earlier
stage created it. Review `target/fly-stage/STAGE-MANIFEST.json`: `commit`,
`deploy_files_from: "commit"`, `invite_smoke: "invite smoke ok: …"`, and one
SHA-256 per file.

`--test-deploy-from-worktree` takes `exchange/deploy` from the checkout
instead of the commit. It exists only to test the package before it is
committed; the manifest then says `worktree (TEST ONLY - do not deploy)`.
**Never deploy such a context**; re-stage from the commit.

### 3. Optional local image build (needs Docker)

Docker is **not on the Windows PATH** of this machine, so the image has not
been built. On any machine with Docker:

```text
docker build -t xythum-coordinator:check target/fly-stage
```

The build fails if the Linux prover does not re-derive the pinned verifying
keys, if any pinned file differs at its runtime path, if the invite smoke
check fails, or if the server's credential loader does not scrub. Without
Docker, `fly deploy --remote-only` (step 6) builds on Fly's remote builder,
which **uploads the staged context (about 205 MB) to Fly**, so it is part of
the approved launch. In that case the first Linux build happens during the
paid launch; watch its log for `launch: self-check ok`.

### 4. Least-privilege secrets file (local; run it yourself)

```text
node exchange/deploy/secrets.mjs --from E:\github2\perp\xythum-near-perps\.env --app <app> --out-dir E:\github2\perp\xythum-near-perps\.testnet\fly
```

This writes `<app>.secrets.env` (the role variables plus the invite, as
`NAME=value` lines) and `<app>.invite.txt`
(`https://<app>.fly.dev/#invite=<64 hex>`) into an owner-only, Git-ignored
directory. It never overwrites; `--reuse-invite` keeps an existing invite.
Only names are printed. Keep both files private and outside any staging
context; the tool refuses to write inside one.

`--mounted-file <absolute path>` is for a host that can mount a secret file
(this `fly.toml` does not configure one). It writes the role variables to
`<app>.credentials.env`, to be mounted read-only at that path outside `/app`,
and `<app>.secrets.env` with only `XYTHUM_HOSTED_INVITE` and
`XYTHUM_CREDENTIALS_FILE=<path>`. The server scrubs environment variables,
not the mounted file, which stays readable for the app user.

### 5. Verify the shared root funds (free, read-only RPC)

```text
node exchange/deploy/check-funds.mjs --sessions 1
```

On 2026-11-12 this reported 4.40 NEAR spendable above the 1 NEAR reserve
(about 3.06 NEAR per session) and 520,000 mUSDC cents (120,100 per session):
enough for **exactly one** more session, local or remote. The coordinator's
own preflight still refuses a session the root cannot cover
(`503 root_capacity`). Re-run this right before launch.

### 6. Paid launch (requires explicit owner approval)

```text
fly auth whoami
fly apps create <app> --org <org>
fly volumes create xythum_sessions --app <app> --region iad --size 1 --yes
fly secrets import --app <app> --stage < E:\github2\perp\xythum-near-perps\.testnet\fly\<app>.secrets.env
fly deploy target/fly-stage --config target/fly-stage/fly.toml --app <app> --remote-only --ha=false --no-public-ips
fly ips allocate-v4 --shared --app <app>
fly ips allocate-v6 --app <app>
```

In PowerShell, pipe the secrets file instead of using `<`:
`Get-Content -Raw <file> | fly secrets import --app <app> --stage`.
`--stage` stores the secrets without restarting anything. **`--ha=false` is
required**: it stops the first deploy from creating Fly's default second,
high-availability Machine. Do not rely on it alone; verify one Machine and
one volume in step 7. `--no-public-ips` prevents a dedicated IPv4 so only the
shared IPv4 and IPv6 are allocated. Create exactly one volume, before the
deploy.

### 7. Post-launch checks

```text
fly status --app <app>
fly machine list --app <app>
fly volumes list --app <app>
fly ips list --app <app>
fly logs --app <app> --no-tail
curl -fsS https://<app>.fly.dev/api/health
curl -sI http://<app>.fly.dev/
```

Expected results:

- `fly machine list` shows **exactly one** Machine: started, `iad`,
  `shared-cpu-2x`, 2048 MB. If there are two, destroy the extra one before
  opening the invite (`fly machine destroy <id> --app <app> --force`).
- `fly volumes list` shows **exactly one** volume, `xythum_sessions`,
  attached to that Machine's ID.
- shared IPv4 and IPv6, no dedicated IPv4
- logs show `launch: lock: none`, `launch: starting coordinator as uid 10001
  (quota 1)`, and the banner `xythum session coordinator (hosted, invite
  required) on http://0.0.0.0:8080 (… 0/1 sessions)`
- health returns `{"ok":true,"chain_id":"testnet","sessions":0,"session_quota":1}`
- plain HTTP redirects to HTTPS

Then open the invite link from `<app>.invite.txt` in one browser. After its
session exists, `sessions` reads 1 and the quota is spent.

### Operating notes

- **One active writer for the shared signers.** The local Windows
  coordinator and the hosted one sign with the same `DEMO`, `MARKET`,
  `MAKER`, `ORACLE` and `KEEPER_B` keys. Each serializes nonces only within
  its own process, and the `coordinator.lock` pid lock only covers one
  session directory, so nothing prevents the two from signing at the same
  moment. Operate them so that only one is an active writer at a time: stop
  the local coordinator (including its keeper worker) before deploying or
  starting the hosted Machine, and stop the hosted Machine
  (`fly scale count 0 --app <app>`) before restarting the local one. Never
  run two hosted Machines. A nonce collision surfaces as a failed step, but
  the procedure, not the code, is what keeps it rare.
- **Independent price assumptions.** Each session gets its own fresh market
  and its own oracle rounds. Marks are test prices posted by the shared
  `ORACLE` key within `XYTHUM_MARK_MIN_TICKS..XYTHUM_MARK_MAX_TICKS`; they
  are not market data. The local and hosted coordinators do not share or
  synchronize prices, funding or positions; nothing about one session's
  marks says anything about the other's.
- **Stop spending:** `fly scale count 0 --app <app>` stops the Machine and
  keeps the volume. To change the quota, edit `fly.toml`, re-stage and
  redeploy; the launcher caps it at 1.
- **Teardown (irreversible, deletes the volume):** `fly apps destroy <app>`.
  Session NEAR and mUSDC already spent on testnet are not reclaimed.
- **New artifacts:** if the market Wasm or proving keys change, update
  `artifacts.lock.json`, the Wasm pin in `Dockerfile`/`fly.toml`,
  `prover-pins.js` and `PINNED_VK_FINGERPRINTS` together. The stage fails if
  they disagree.
- **Base images:** the Dockerfile pins tag plus index digest as looked up on
  2026-11-12. Refresh them with `docker buildx imagetools inspect <tag>`.
- Hosted creation cooldown is keyed by socket address, and behind the Fly
  proxy that is effectively global. With a quota of 1 this does not matter.

## Verification so far (2026-11-12, all local, offline, no uploads)

- `node --check` passes on every package file. `deploy.test.mjs` (13 tests)
  passes in this worktree with Node 22.10; `secrets.test.mjs` (4 tests) passes
  in a temporary copy linked to the original repository's installed
  dependencies, and the image self-check's credential handoff check passed
  there too.
- A test-only stage of `e7df2c1` with `--test-deploy-from-worktree` and the
  seven artifacts from the original worktree produced 64 files (205.4 MB),
  the invite smoke check passed against the staged server (6 refused before
  the coordinator, 1 admitted), and the scan was clean. Re-runs that failed
  (missing artifacts, non-Git `--source`) left that context byte-for-byte in
  place with no scratch directory behind.
- **Not done:** any Linux build (no Docker here; the Rust prover, `npm ci`,
  the Vite build and `--self-check` have not run in the Linux image), a
  stage from a commit that contains the package, a hosted boot, and anything
  on Fly.
