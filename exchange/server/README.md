# Original exchange session coordinator (testnet)

The current Shielded Pool uses [`judge-server.mjs`](judge-server.mjs). See the [operator guide](../../docs/SHIELDED-COLLATERAL.md#shielded-pool-with-offline-liquidation) for setup.

A small Node HTTP service that gives each consumer browser its own isolated
Quiet Margin market on NEAR testnet. It runs the existing maker, oracle and keeper
roles for that market. It never generates or holds a trader key.

```text
node exchange/server/server.mjs
```

Run this from the repository root. It needs the same setup as
`scripts/testnet-demo.mjs`:

- `npm ci --ignore-scripts`
- the market Wasm at `target/near/xythum_near_perps.wasm`, or set `MARKET_WASM`
- the release prover at `prover/target/release/xythum-prover`, or set `PROVER_BIN`
- the local `.env`, read through `loadDemoEnv`
- the deployment's proving keys in `.testnet/proving/`

By default it listens on `127.0.0.1:8790`, where the Vite dev server can
proxy `/api` to it. To create sessions, set `XYTHUM_SESSION_QUOTA`.
Without it, the server starts with session creation turned off.

Offline tests use a mock chain and injected actors. They make no RPC
calls and read no credentials:

```text
node --test exchange/server/test/*.test.mjs
```

## What one session creates

The session key `s-<24 hex>` is random. From it the coordinator derives
`trader-<12 hex>.<demo root>` and `market-<12 hex>.<demo root>`. Then, in order:

1. The root creates the market account and funds its storage, computed as
   Wasm bytes × 10¹⁹ yocto + 0.5 NEAR. The account gets the existing `MARKET`
   role key only so it can deploy.
2. The market account deploys the Wasm, calls `init`, and deletes that key,
   all in one atomic batch. The market is locked from then on. `init` uses
   the existing token, maker, oracle and both keepers with their ack keys.
   It also takes a fresh random 32-byte `deployment_id` and the verifying
   keys re-derived with `prover keys` from the existing proving directory.
   At startup those keys are checked against the pinned testnet fingerprints.
3. The root registers the market with the mock token (`storage_deposit`).
4. The maker vault is funded to `XYTHUM_MAKER_VAULT_MUSDC`. If the maker
   wallet is short, the root tops it up, then the maker signs
   `ft_transfer_call(msg: "maker")`.
5. The oracle publishes round 1 at `XYTHUM_INITIAL_PRICE_TICKS` with funding 0.
6. The root creates the trader account with `XYTHUM_TRADER_NEAR` of gas money
   and only the browser's full-access public key. This runs last, so the key
   is public on chain only briefly before setup finishes.
7. The root registers the trader with the token and sends it
   `XYTHUM_TRADER_MUSDC`. The browser deposits that itself with
   `ft_transfer_call(msg: "trader")`.

Each step first checks final chain state and the step markers in the durable
record. A retry or a restart therefore resumes without repeating anything
that already landed. The coordinator refuses to adopt an account it did not
record creating. It never signs for, deploys to, or calls the existing demo
market or any existing role account. The coordinator checks this, and the
testnet adapter checks it again.

## HTTP API

All bodies are JSON and capped at 4 KiB. Unknown request fields are rejected.
That rules out `margin_cents`, a position blinder, or a witness on any endpoint.

| Endpoint | Body | Response |
| --- | --- | --- |
| `POST /api/sessions` | exactly `{public_key, proof}` (see Sessions) | `201` session view |
| `GET /api/session` | (bearer) | session view with fresh oracle, ledger, receipts |
| `POST /api/session/approve` | `{nonce, commitment, quote_blinder, size_lots, entry_ticks}` | `{acknowledgments: [sig, sig], receipt: {label, hash}}` |
| `POST /api/session/mark` | `{price_ticks}` | `{oracle, receipt}` |
| `POST /api/session/refresh` | exactly `{}` | `{oracle, receipt?}` |
| `POST /api/session/keeper` | `{armed: true}` | `{keeper_armed, receipt?}` |
| `GET /api/proving/open.pk`, `GET /api/proving/close.pk` | none | the original proving-key file bytes |
| `GET /api/health` | none | `{ok, chain_id, sessions, session_quota}` |

The session view is
`{session_id, trader_id, market_id, token_id, chain_id: 'testnet', rpc_url, keeper_encryption_keys: [A, B], keeper_armed, receipts: [{label, hash}], oracle?, ledger}`.
`receipts` holds at most the latest 64 receipts. The durable record keeps
the full history.
The authenticated endpoints take `Authorization: Bearer <session_id>`.
Errors are `{error, message}` with a 4xx or 5xx status. Rate limits answer
`429` with `Retry-After`.

- **Sessions.** `public_key` is a canonical `ed25519:<base58>` key. `proof`
  is the canonical padded Base64 of the 64-byte Ed25519 signature, by that
  key, over the UTF-8 string `xythum:exchange:session:v1:testnet:` followed by
  `public_key`. The proof is verified before anything else is consulted
  (setups in flight, durable records, quota, cooldown). A missing, malformed
  or wrong proof gets `400`/`401 invalid_proof` and learns nothing about
  whether that key has a session. The bearer `session_id` is the 43-character
  base64url
  `SHA-256("xythum:exchange:bearer:v1:" ‖ signature bytes)`. Only its
  SHA-256 hex is stored, and neither the proof nor the bearer is logged.
  Ed25519 signing is deterministic, so the key holder can always re-derive
  the proof. Requests with the same key and proof share one setup, which
  is claimed synchronously before any asynchronous work. A setup that failed
  or was interrupted resumes when the same proof is posted again
  (`502 setup_incomplete` until then). Posting it again after the session
  is ready returns the same session and capability, with no transaction and
  no quota or cooldown charge. A valid but different proof for a bound
  session gets `409 session_exists`.
- **Approve.** The browser stages the position itself. The server reads
  `get_pending`, requires the nonce and commitment to match, and rebuilds the
  offer context from the market, the nonce and the staged funding checkpoint.
  It then runs `makerApproval`, which checks the quote digest, 1–50 lots, and
  a ±1% price band. It also checks the maker reserve. Next, Keeper A and
  Keeper B actors each decrypt only their own envelope and sign. Only then
  does the maker submit `approve_quote` with a `XYTHUM_QUOTE_TTL_BLOCKS`
  expiry, and the server waits for it to be final. A retry of a still-live
  approval returns the recorded receipt without a new transaction.
- **Mark.** The oracle publishes `round + 1` at the requested price and keeps
  the cumulative funding index unchanged, so republishing the same price is
  safe. Marks are bounded by `XYTHUM_MARK_MIN_TICKS..XYTHUM_MARK_MAX_TICKS`,
  a per-session minimum interval, and a per-session count.
- **Refresh.** Keeps the oracle round usable for a close (or open) without
  a user price. If the current round is younger than
  `XYTHUM_REFRESH_AFTER_BLOCKS` (600), it is returned as is, with no
  transaction. Otherwise the oracle republishes the current price and
  cumulative funding as `round + 1` (receipt `refresh_<round>`), well before
  the contract's 1000-block freshness limit. It does not use the mark quota
  or interval, and has no lifetime cap, so it can keep an open position
  closable for as long as the session lives. The bound is elapsed block age:
  the final round's age is re-read under the oracle-signer lock before any
  send, so at most one publish lands per `XYTHUM_REFRESH_AFTER_BLOCKS` window
  and a refresh that already landed is reused. A failed send records nothing
  that blocks a retry by blocks; it only defers the next attempt by a short
  backoff (`429 refresh_retry`, 2 s). It holds the same session and
  oracle-signer locks as a mark.
- **Keeper.** Arming requires an active slot and pins its nonce and
  commitment. The first attempt runs inline. After that, a background
  worker tries each distinct oracle round, whether or not the browser is
  still connected. A round is finished when it is liquidated, when the
  prover refuses it with its exact healthy-position message, or after
  `MAX_ROUND_ATTEMPTS` (3) transient prover/RPC failures; until then the
  worker retries the same round while the pinned slot is still active. Keeper B runs as a cold `tests/actor.mjs`
  process with a temporary keeper file (its encryption key and transaction
  key only) and the public proving key. It is passed the armed slot's
  `expectedNonce` and `expectedCommitment`, so it refuses any other slot
  before it proves or signs. A healthy round fails inside the
  local prover, so no transaction is sent. When the slot clears, the worker
  records the outcome (`liquidated` or `settled`) with the final ledger and
  disarms.

## Safety and cost bounds

- **Testnet only.** It uses the pinned `TESTNET_RPC`, requires chain ID
  `testnet`, and requires a named `.testnet` demo root, all through
  `scripts/testnet-client.mjs`.
- **Spend limits.** `XYTHUM_SESSION_QUOTA` (1–50) is required to create
  sessions and counts every durable session record. One setup runs at a time,
  with a bounded queue (`XYTHUM_SETUP_QUEUE`). A preflight refuses a session
  the root cannot cover in NEAR (keeping `XYTHUM_ROOT_RESERVE_NEAR`) or in
  mUSDC. When hosted, each client address has a creation cooldown.
- **Nonces.** Every transaction signed by a shared role key (root, maker,
  oracle, market deploy key, Keeper B) is serialized per signer. A pid lock
  in the session directory stops a second coordinator from running.
  Record writes from HTTP requests and the keeper worker are serialized per
  session inside the store: each save snapshots the record when called and
  is written, in call order, through its own temp file and an atomic rename.
  Temp files left by a crash are discarded at startup.
- **Secrets.** Durable records live in `XYTHUM_SESSION_DIR`, which defaults to
  `.testnet/exchange-sessions/` and is ignored by Git. They hold only public
  chain data and a SHA-256 of the bearer token. The token, keys and request
  bodies are never logged. Logs carry the method, route, status and latency.
  Error text is redacted before it is logged or stored. The NEAR SDK's
  receipt logging is silenced. Keeper secrets reach a child process only
  through a temporary file that is deleted after each run. That file is
  written under `XYTHUM_SESSION_DIR/keeper/`, never the shared system temp
  directory. Before the first secret is written, that directory is
  restricted and checked. On Windows its DACL is replaced with one inheritable
  full-control ACE for the current user, using `System32\icacls.exe`, and
  read back as SDDL. It must be protected and grant only that SID. On POSIX
  it must be mode `0700` and owned by the current user. If the check fails,
  the server refuses to start. Stale files from a crashed run are removed.
  Do not set
  `NEAR_WORKSPACES_DEBUG`, because it prints transaction actions.
- **Static files.** If `exchange/dist/` exists, it is served with
  traversal checks and a single-page-app fallback. Paths with any segment
  starting with `.` (`/.env`, `/.git/...`, `/.well-known/...`) are never
  served and never fall back to the app. Turn this off with
  `XYTHUM_SERVE_DIST=0`. The proving endpoints are two fixed file names.
  The proving directory is never browsable, and `.vk`, liquidation and
  witness files are never served.

## Hosted mode (single instance, e.g. Fly)

Hosted mode is any non-loopback `XYTHUM_SERVER_HOST`. It needs
`XYTHUM_ALLOW_HOSTED=1`, and in addition:

- `XYTHUM_HOSTED_INVITE`: 32 random bytes as 64 lowercase hex digits
  (`openssl rand -hex 32`). `POST /api/sessions` must carry it as
  `X-Xythum-Invite`. A missing, malformed or wrong value gets
  `401 invite_required` before the body is read and before the coordinator
  sees the request, so no proof check, quota, cooldown or provisioning runs.
  The shape is checked first, then the 32 bytes are compared in constant
  time. Every other route keeps the per-session bearer only.
- Absolute `XYTHUM_SESSION_DIR`, `XYTHUM_PROVING_DIR`, `MARKET_WASM` and
  `PROVER_BIN`, so nothing falls back to the repository's `.testnet` data.
  For the Fly image: `XYTHUM_SERVER_HOST=0.0.0.0`,
  `XYTHUM_SESSION_DIR=/data/sessions`, `XYTHUM_PROVING_DIR=/app/artifacts/proving`,
  `MARKET_WASM=/app/artifacts/market.wasm`, `PROVER_BIN=/app/bin/xythum-prover`.
- Role credentials from runtime variables only (`loadHostedEnv` in
  `scripts/testnet-client.mjs`), or from one KEY=VALUE file named by
  `XYTHUM_CREDENTIALS_FILE`, which must be an absolute path outside the
  repository. That check runs on the given path and again on the canonical
  (symlink/junction-resolved) paths of the file and the repository, and the
  canonical file is what is read, so a link outside the repository that
  points into it is refused. The local `.env` is never read. The variables are
  `NEAR_NETWORK_ID=testnet`, `NEAR_RPC_URL` (the pinned testnet RPC),
  `NEAR_<ROLE>_ACCOUNT_ID` for all eight roles, `NEAR_<ROLE>_SECRET_KEY` and
  the matching `NEAR_<ROLE>_PUBLIC_KEY` for the signers `DEMO`, `MARKET`,
  `MAKER`, `ORACLE` and `KEEPER_B`, and `NEAR_KEEPER_{A,B}_{ENCRYPTION,ACK}_{SECRET,PUBLIC}`.
  Public keys for `TOKEN`, `TRADER` and `KEEPER_A` are optional. Their
  `SECRET_KEY`s are never used by the host and are refused if set. Each
  keeper secret must derive its published public key. Credentials are loaded
  first at startup, before any child process: the secret variables, the
  refused unused keys and the invite are then deleted from `process.env`
  (also when loading fails). The native prover and the keeper actors run
  with an explicit minimal environment (`PATH`, `SystemRoot`, `TEMP`/`TMP`,
  `HOME`/`USERPROFILE`, `PROVER_BIN`), so no other runtime secret is
  inherited either. Errors name variables, never values.

The client takes the invite from a `#invite=<64 hex>` link fragment at
startup, removes it from the address bar with `history.replaceState`, and
keeps it in `sessionStorage` for enrollment and retries. The newest link
wins: a malformed or duplicated `invite=` clears any stored invite, so
enrollment fails with `invite_required` instead of silently reusing an old
one. An existing session keeps working, since it authenticates with its own
bearer and never with the invite. It sends it only on
`POST /api/sessions`. Without an invite (local mode) nothing changes.

Hosted responses also carry `Content-Security-Policy`
(`default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; worker-src 'self';
connect-src 'self' https://test.rpc.fastnear.com; style-src 'self';
frame-ancestors 'none'`, and so on), `X-Frame-Options: DENY`, HSTS,
`Cross-Origin-Opener-Policy: same-origin` and a restrictive
`Permissions-Policy`. The existing hosted exchange and explicit
`?wallet=legacy` route use the original flow.

For the connected wallet testnet exchange, run on loopback with
`XYTHUM_WALLET_FAUCET=1` and an explicit funded session quota.
Set `XYTHUM_LIVE_MARKET=1` to use Binance spot snapshots for the signed
NEAR mark. The chart is a continuously refreshed BTC/USDT spot reference;
NEAR settles against its last published USD mark, which the browser checks
before order review and close. The coordinator signs that mark; the source
is not independently attested. Controlled test marks remain available in
the original demo. The connected mode is disabled in hosted mode while
its external wallet integration is adapted to the hosted CSP.

Connect without adding a NEAR access key. Then sign a message to derive a
separate, origin-bound private trader key. Using the same wallet key and
origin restores that trading account, but does not restore a position
opening that was stored only in another browser. To start trading, sign
another message to claim one 600 mUSDC test grant per NEAR account. The
faucet sees both identities when it verifies that claim. The original
account is absent from the resulting on-chain grant and trade payloads.
The fixed 600 mUSDC escrow and settlement are public. This feature does
not accept real USDC or put the test grant in a shared shielded pool.

## Configuration

| Variable | Default | Bound |
| --- | --- | --- |
| `XYTHUM_SERVER_HOST` / `XYTHUM_SERVER_PORT` | `127.0.0.1` / `8790` | a non-loopback IP needs `XYTHUM_ALLOW_HOSTED=1` |
| `XYTHUM_HOSTED_INVITE` | none | required when hosted: 64 lowercase hex |
| `XYTHUM_CREDENTIALS_FILE` | unset (runtime variables) | hosted only; absolute, outside the repository |
| `XYTHUM_SESSION_QUOTA` | unset (creation off) | 1–50 |
| `XYTHUM_WALLET_FAUCET` / `XYTHUM_LIVE_MARKET` | off | opt in with `1`; wallet faucet is loopback only |
| `XYTHUM_SESSION_DIR` | `.testnet/exchange-sessions` | must not be `.testnet` or the proving directory |
| `XYTHUM_PROVING_DIR` | `.testnet/proving` | must hold `open.pk`, `close.pk`, `liquidation.pk` |
| `XYTHUM_VK_FINGERPRINTS` | recorded testnet fingerprints | JSON `{open, liquidation, close}` |
| `MARKET_WASM` / `XYTHUM_MARKET_WASM_SHA256` | `target/near/…wasm` / unpinned | optional hex pin |
| `XYTHUM_TRADER_NEAR` | `0.5` | ≤ 2 NEAR |
| `XYTHUM_MARKET_NEAR` | Wasm size + 0.5 NEAR | ≤ 6 NEAR |
| `XYTHUM_ROOT_RESERVE_NEAR` | `1` | ≤ 100 NEAR |
| `XYTHUM_TRADER_MUSDC` | `60000` cents | 60,000–120,000 |
| `XYTHUM_MAKER_VAULT_MUSDC` | `60100` cents | 60,100–240,400 |
| `XYTHUM_INITIAL_PRICE_TICKS` | `10000` | within the mark band |
| `XYTHUM_MARK_MIN_TICKS` / `XYTHUM_MARK_MAX_TICKS` | `1` / `20000` | 1–20,000 |
| `XYTHUM_MARK_INTERVAL_MS` / `XYTHUM_MARKS_PER_SESSION` | `2000` / `100` | ≤ 600 s / ≤ 1,000 |
| `XYTHUM_REFRESH_AFTER_BLOCKS` | `600` | 100–900 |
| `XYTHUM_APPROVALS_PER_SESSION` | `20` | ≤ 200 |
| `XYTHUM_QUOTE_TTL_BLOCKS` | `500` | 10–900 |
| `XYTHUM_KEEPER_POLL_MS` | `5000` | 0.5–600 s |
| `XYTHUM_SETUP_QUEUE` | `4` | 1–16 |
| `XYTHUM_CREATE_COOLDOWN_MS` | `0` local, `60000` hosted | ≤ 1 day |
| `XYTHUM_SERVE_DIST` / `XYTHUM_DIST_DIR` | on / `exchange/dist` | |

At the default amounts, each session costs about 0.5 NEAR for the trader,
about 2.4 NEAR of market storage for the current 194 KB Wasm, and two
registration deposits plus gas. It also uses 120,100 mUSDC cents. The
mock token supply is fixed at 1,000,000 cents and has no further minting,
so the root's remaining mUSDC caps how many sessions are possible in total.

## Not done yet

- Nothing has run against testnet. Every check so far is offline, against the
  mock chain and a fake SDK chain. The first real run should use
  `XYTHUM_SESSION_QUOTA=1` and its receipts should be checked by hand.
- Session NEAR and mUSDC are not reclaimed. Markets are locked once
  deployed, so their storage NEAR stays put. Maker vault funds could be
  withdrawn later with `withdraw`, but no job does that.
- A setup interrupted on the server is resumed only when the browser posts
  the same public key again. There is no automatic background resume.
- The proof is a bearer secret in its own right, since the capability is
  derived from it. Anyone who captures a proof (for example from a logging
  proxy) can re-derive `session_id`. Serve over TLS and keep request bodies
  out of proxy logs.
- Session records written before proofs were required are not migrated.
  A ready legacy record keeps its original random bearer, so posting a proof
  for it gets `409`. A provisioning legacy record binds to the first valid
  proof.
- Hosted mode limits creation by socket address only and does not trust
  `X-Forwarded-For` or `Fly-Client-IP`. Behind a proxy every client shares
  one address, so the creation cooldown is effectively global. Admission is
  the shared invite: anyone holding the link can create sessions up to the
  quota.
- `keeper_armed` and the settlement outcome are kept only in the durable
  record. The session view exposes `keeper_armed` and the
  `liquidation_<nonce>` receipt, not the full attempt history.
