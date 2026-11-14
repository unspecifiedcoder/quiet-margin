# Original funded-market exchange

For the current long and short trading flow, start with the [Shielded Pool guide](SHIELDED-COLLATERAL.md) and [demo receipts](QUIET-MARGIN-DEMO.md).

`exchange/` is the consumer app. It has three parts: a browser client with an
in-browser Groth16 prover, a Vite UI, and a Node session coordinator
(`exchange/server/`). The coordinator provisions one trader account and one
isolated clearing market per visitor. It does this under the existing demo
root, with the existing maker, oracle, keepers, mock token, and proving keys
([`docs/TESTNET-ADDRESSES.md`](TESTNET-ADDRESSES.md)).

> **Status.** One full local run against NEAR testnet has been recorded (see
> [Verified local testnet run](#verified-local-testnet-run)). The coordinator
> and the UI ran on the developer machine, and the chain was public NEAR
> testnet. Scope: long-only, mock collateral, testnet only. There is no hosted
> instance and nothing on mainnet. The earlier read-only judge replay in
> [`JUDGES.md`](../JUDGES.md) is kept unchanged as the fallback evidence.

## Layers and tags

The work is split into additive layers. Each layer leaves the ones below it
unchanged.

| Layer | Tag | Commit | What it adds |
| --- | --- | --- | --- |
| 0 | `milestone/native-testnet` | `0413bd2` | Native NEAR contracts and the operator-driven testnet deployment |
| 0 | `milestone/judge-evidence` | `8911974` | Judge replay, receipt verifier, keeper binding, operator enrollment checks |
| 1 | `milestone/exchange-funding` | `9211f49` | Browser-owned sessions, in-browser proving, funded open/close/withdraw, cold Keeper B |

At both layer 0 tags, `node scripts/verify-demo-receipts.mjs` still passes
96/96 live receipt checks. Layer 1 is the exact commit `9211f49`; the run
below used that commit.

## Verified local testnet run

Machine: the developer's Windows machine, Microsoft Edge, local coordinator
and Vite UI, public NEAR testnet RPC. Transaction links open on
[testnet.nearblocks.io](https://testnet.nearblocks.io/).

**Explicit Start.** Fresh Edge visits made no signer and sent no `POST`
until the user clicked Start. A fresh Start then provisioned a distinct pair,
`trader-727c93ecd6da.xythum-perps-demo.testnet` and
`market-727c93ecd6da.xythum-perps-demo.testnet`.

**Primary tested session.**

- Trader: `trader-62fff129df71.xythum-perps-demo.testnet`
- Market: `market-62fff129df71.xythum-perps-demo.testnet` (keyless after setup)
- Token: `musdc.xythum-perps-demo.testnet` (mock mUSDC)
- The browser was the only signer for the trader account.
- The maker vault started with 1,000 mUSDC (`XYTHUM_MAKER_VAULT_MUSDC=100000`).

| Step | Detail | Transaction |
| --- | --- | --- |
| Deposit | 600 mUSDC, signed in the browser | [`DJvgPi8g…xkR8`](https://testnet.nearblocks.io/txns/DJvgPi8gQZtKcbSFDHCNK3zNsohxvYXBFrqQ6UE8xkR8) |
| Open | Long 0.008 BTC with 450 mUSDC margin, chosen by the user. 65.6 s end to end on this machine. | [`9jm21tNY…6JQD`](https://testnet.nearblocks.io/txns/9jm21tNY6doDZKxLmmmfVPNGhaiRqTVa3uUMsERo6JQD) |
| Close | At a $112,000 mark. 696 mUSDC credited. | [`FxdAqT9S…LFQT`](https://testnet.nearblocks.io/txns/FxdAqT9SUcKW7gCjyEnPydSYjkQgt64Um4xLhMdLUFQT) |
| Withdraw | 96 mUSDC profit back to the trader account | [`4E3Pc2w1…yEr`](https://testnet.nearblocks.io/txns/4E3Pc2w1GtpuUtTMw93bpUfW2mrTvmtTv4WtVPozhyEr) |
| Open | Long 0.010 BTC with 500 mUSDC margin | [`Cyq8EndN…MB6B`](https://testnet.nearblocks.io/txns/Cyq8EndNRHqza2TWRfT95JAGXqah49Vyn2SwCScyMB6B) |
| Arm Keeper B | Armed at a $70,000 mark. The position was healthy and the active slot stayed unchanged. | — |
| Liquidate | With the trader's browser tab closed, the test oracle published $52,000 through the session API. A separate Keeper B actor then liquidated. | [`F5zj6buC…54dD`](https://testnet.nearblocks.io/txns/F5zj6buC35jzdVesQxHWX4m6YJaBiFje5eBfbJ3a54dD) |

**Final balances** (mUSDC): trader claim in the market 119, maker 1,384,
Keeper B 1. The market's token balance is 1,504, equal to the sum of those
claims. Bad debt is zero.

**What this run does not show.** The maker, oracle, Keeper A, and Keeper B
all used the same operator's keys from one `.env`. This was not an
independent-operator trial. It used only long positions and mock assets, and
nothing was hosted or deployed to mainnet.

### Local proving measurements

The browser prover and its build and smoke tests are documented in
[`prover/browser/README.md`](../prover/browser/README.md). Measured locally on
the same machine with an otherwise quiet browser:

- `open`: about 34 s to prove; peak WASM memory about 463 MiB.
- `close`: about 15 s to prove.

The mobile layout was tested at a real mobile viewport. Proving on a phone
has **not** been tested.

## Using the app

1. **Start an account.** A fresh visit does nothing until you click Start.
   It creates no key and sends no request. On Start, the browser generates an
   Ed25519 key and keeps it in IndexedDB (`xythum-exchange`). It uses a
   non-extractable WebCrypto key where it can. Otherwise it falls back to a
   random secret in origin storage, and the UI shows this as `origin-storage`
   (`exchange/src/protocol/signer.js`). The browser enrolls with
   `POST /api/sessions` (see [Session enrollment](#session-enrollment)). The
   coordinator then creates `trader-<id>.<root>` holding only that key as
   full access, and it deploys and locks `market-<id>.<root>`. It also funds
   the maker vault, publishes a first oracle round, and sends the trader
   account test NEAR and 60,000 mock-mUSDC cents (600 mUSDC).
   Before signing anything, the browser checks the market configuration, the
   verifying-key digests, and the distinct roles on chain
   (`exchange/src/protocol/controller.js`, `api.js`). After a reload, a saved
   session reattaches automatically. A reload never creates a key or enrolls
   (`exchange/src/main.js`).
2. **Deposit mock funds.** Deposit moves mUSDC from your trader account into
   the market with `ft_transfer_call` (1 yocto, signed in the browser). An open
   locks a fixed 600.00 mUSDC escrow, so deposit at least that much.
3. **Choose size and margin.** Size is 1–50 lots of 0.001 BTC. Margin is
   0.01–600.00 mUSDC. Leverage is at most 3x at the current mark. The quote
   panel shows entry, notional, leverage, and liquidation price.
4. **Review and open.** The review dialog asks you to confirm again if the mark
   moves. On open, the browser:
   - stages a salted commitment;
   - encrypts the opening to both keepers;
   - asks the coordinator for maker approval and keeper acknowledgments;
   - verifies both acknowledgment signatures;
   - proves `open` locally in a Web Worker;
   - submits `open`.

   The proving key (about 101 MB) downloads from `/api/proving/open.pk` and is
   checked before use (see [Proving-key pins](#proving-key-pins)).
5. **View receipts.** The Receipts tab lists each transaction with a
   `testnet.nearblocks.io` link. Transactions signed by the server (maker
   approval, oracle marks, Keeper B) show `final` only after the browser
   checks them at FINAL: the transaction must succeed, come from the expected
   signer, and call the expected method on this market. Otherwise they stay
   `unverified` (server-reported).
6. **Close and withdraw.** Close requests a fresh oracle round and proves
   `close` locally. It checks the refund against the local settlement model,
   then submits. Withdraw sends available mUSDC back to your trader account.
7. **Optional: deterministic mark.** The test tools publish a mark of your
   choice to *your session's market only*, in $10 ticks. Marks are limited by
   rate (`XYTHUM_MARK_INTERVAL_MS`), count (`XYTHUM_MARKS_PER_SESSION`), and
   range (`XYTHUM_MARK_MIN_TICKS`/`MAX_TICKS`). The UI can prefill a price just
   past liquidation.
8. **Optional: cold Keeper B.** Arming Keeper B pins your active slot's nonce
   and commitment. The coordinator's background worker then watches that slot
   whether or not your browser is still open. It tries each new oracle round,
   with up to 3 attempts per round on transient failures. The keeper actor
   refuses any other slot, and the local prover refuses healthy positions
   before any transaction is sent (`exchange/server/worker.mjs`,
   `exchange/server/README.md`). If Keeper B liquidates first, your close is
   refused on chain and the UI says so.

### What this is, and what it discloses

- **Testnet only, no real assets.** mUSDC is a mock token with no cash value.
  The test NEAR comes from the operator's demo root.
- **Long-only, one slot per visitor.** You get one BTC long at a time on one
  market per browser key. There are no shorts and no order book. A single
  demo maker quotes at the oracle mark.
- **Single trusted oracle.** One operator-controlled oracle account signs
  every mark, including the marks you choose. A stalled oracle leaves a
  position locked.
- **Who sees what.** The chain sees a salted commitment and the fixed escrow.
  The maker (via the coordinator) sees size and entry. Both designated keepers
  (Keeper A and Keeper B, both run by the operator) can decrypt the full
  opening, including margin and blinder. The browser never sends margin, the
  blinder, or the witness to the coordinator in plaintext. The `/api` request
  bodies are built from allowlists (`exchange/src/protocol/api.js`), and the
  server rejects unknown fields.
- **Settlement inference.** A close or liquidation publishes the refund and
  any bad debt. Together with size, entry, and the public mark, this lets an
  observer infer margin after settlement.
- **Default route custody.** The signing key and the sealed
  opening (AES-GCM under a non-extractable vault key,
  `exchange/src/protocol/store.js`) exist only in this browser origin. There
  is no export. If you clear site data or switch browser or profile, you lose
  the ability to sign deposits, withdrawals, and voluntary closes. The keepers
  can still liquidate from their encrypted copy if the mark crosses
  liquidation. The private wallet route below supports signing-key recovery.

### Private wallet (`?wallet=burner`)

The default route works exactly as described above. Its **Private wallet**
link opens a separate same-origin route that uses a built-in NEAR testnet
burner (an implicit account) with demo mUSDC collateral. The link stays
visible in every state, including for a browser already connected on the
default route; that session is not changed.

1. **Create burner wallet** or **Recover from a backup file**. The file is a
   local JSON file of at most 1 KB (1024 characters), read only in the
   browser.
2. Review the compact summary (site, network, burner, recipient; the full
   signed text is under **Show the full signed text**), then **Sign and open
   private wallet** (new) or **Sign and recover private wallet** (backup).
   Signing happens locally and sends no transaction.
3. For a new burner, **Download backup file** below the sign button is
   optional, but without it the burner is lost when you leave the page. The
   page reports only **Download requested**: it cannot confirm the browser
   saved the file, so check it. The backup controls the demo wallet and its
   private trading wallet. The page never shows it, logs it or sends it to
   the server.
4. The original trading workspace opens, with the burner account, the private
   trader account and the trader key shown above it. Only then does the
   coordinator act on testnet: a new wallet provisions its trader account
   (`onStart()`); a recovered wallet only reattaches the existing one
   (`onStart({ recoverOnly: true })`) and never creates a trader. If that
   step fails, **Retry private session** (new) or **Retry recovery**
   (backup) repeats it on the same wallet. Backup download errors appear in
   the banner above the workspace.

Backups are bound to the site origin that made them, and recover only on that
same origin. On a hosted invite-only testnet instance, recovery uses
`POST /api/sessions` with `restore_only: true`, so it needs the private
invite like any new session: in the other browser, open the invite link first (the invite is kept
for that tab only), then follow **Private wallet** in the same tab and
**Recover from a backup file**. Without the invite, recovery fails with
`invite_required` and nothing is created.

**Lock private wallet**, a reload and a back/forward cache restore all return
to the landing page. Nothing unlocks again until you sign again. A position
opening is local: it stays in the browser that made it and is not in the
backup. Keep that browser if you want to close an active position
voluntarily.

## Session enrollment

`POST /api/sessions` takes exactly `{ "public_key", "proof" }`
(`exchange/server/README.md`, `exchange/src/protocol/signer.js`):

- `proof` is the browser key's Ed25519 signature over the UTF-8 string
  `xythum:exchange:session:v1:testnet:` followed by `public_key`, in canonical
  padded Base64. The coordinator verifies it before it reads any other state
  or spends anything. A missing or wrong proof gets `400`/`401 invalid_proof`
  and learns nothing about whether that key has a session.
- The bearer is derived from the signature:
  `SHA-256("xythum:exchange:bearer:v1:" ‖ signature)`, base64url. The
  coordinator stores only its SHA-256 and logs neither the proof nor the
  bearer. Ed25519 signing is deterministic, so the key holder can re-derive
  both.
- Posting the same proof again resumes an interrupted setup. Once the session
  is ready, it returns the same session with no new transaction and no quota
  charge. A different valid proof for a bound session gets `409`.
- The proof works as a bearer secret in its own right. Serve over TLS and keep
  request bodies out of proxy logs.

## Proving-key pins

The browser checks keys in two layers (`exchange/src/protocol/prover-core.js`,
`prover-pins.js`):

1. **Full proving-key pin.** The worker downloads the complete uncompressed
   `open.pk` or `close.pk`. It compares the SHA-256 of the full file with a
   pinned release digest before any byte reaches the WASM prover. The
   defaults are compiled in. A deployment can override them at build time
   with `VITE_XYTHUM_OPEN_PK_SHA256` and `VITE_XYTHUM_CLOSE_PK_SHA256`
   (64 lowercase hex digits). A malformed override fails closed.
2. **On-chain verifying-key fingerprint.** The WASM prover then decodes the
   embedded verifying key and compares its SHA-256 with the market's
   `get_config()` `open_vk_sha256` / `close_vk_sha256`.

At startup the coordinator requires `open.pk`, `close.pk`, and
`liquidation.pk` in `XYTHUM_PROVING_DIR` (default `.testnet/proving/`). It
re-derives the verifying keys and refuses to start unless they match
`PINNED_VK_FINGERPRINTS` in `exchange/server/config.mjs`. If you set
`XYTHUM_MARKET_WASM_SHA256`, it also checks the market Wasm. Only
`/api/proving/open.pk` and `/api/proving/close.pk` are served. Compressed
keys (`xythum-browser-keys compress`) are not served.

## Operator setup (local development)

**Requirements**

- Node **22.12 or later** and npm (`exchange/package.json` `engines`).
- rustup with the pinned **Rust 1.95.0** toolchain and the
  `wasm32-unknown-unknown` target (see
  [`rust-toolchain.toml`](../rust-toolchain.toml)), plus cargo-near 0.23.0.
- The repository's existing local `.env` and `.testnet/proving/`. These come
  from the testnet deployment and are never committed or shared. The
  coordinator reads these `.env` variable names, which are documented in
  [`docs/TESTNET-ADDRESSES.md`](TESTNET-ADDRESSES.md):
  - the role keys for `DEMO`, `MARKET`, `TOKEN`, `MAKER`, `ORACLE`,
    `KEEPER_A`, and `KEEPER_B`;
  - `NEAR_KEEPER_{A,B}_ACK_{PUBLIC,SECRET}`;
  - `NEAR_KEEPER_{A,B}_ENCRYPTION_{PUBLIC,SECRET}`.

  Do not create, edit, or print these values. The existing `MARKET` key is
  used only to deploy and lock new session markets, and it is deleted from
  each new market in the same batch.

**Install and build**, from the repository root:

```text
npm ci --ignore-scripts
npm ci --prefix exchange
rustup toolchain install 1.95.0 --target wasm32-unknown-unknown
cargo near build non-reproducible-wasm --locked --no-abi
cargo build --locked --manifest-path prover/Cargo.toml --release
```

The native build provides `target/near/xythum_near_perps.wasm`, which the
coordinator deploys per session. It also provides the native prover that the
keeper actors use (`tests/actor.mjs`, through `exchange/server/actors.mjs`).

**Browser prover** (wasm-bindgen 0.2.130, installed under
`prover/target/tools` if missing). The scripts' own default output is
`prover/target/browser/pkg/`. The exchange instead expects the output in
Vite's default public directory, `exchange/public/prover/`
(`exchange/vite.config.js`). Both scripts `cd` into `prover/` before writing,
so pass an **absolute** output directory:

```text
bash prover/browser/build.sh "$PWD/exchange/public/prover"
powershell -File prover/browser/build.ps1 -OutDir "$PWD\exchange\public\prover"
```

The output is `xythum_prover.js`, `xythum_prover_bg.wasm`, the `.d.ts` files,
and `snippets/`, all Git-ignored. Keep `snippets/` next to the module. Vite
serves the directory unmodified at same-origin `/prover/` in dev and preview,
and copies it verbatim into `exchange/dist`. The proving worker imports
`/prover/xythum_prover.js`. For the synthetic smoke tests, see
[`prover/browser/README.md`](../prover/browser/README.md). They create fresh
throwaway keys and never read `.env` or `.testnet`.

**Run.** Session creation stays off until you set a quota. The quota below
(3) is only an example; any value from 1 to 50 works. The maker-vault override
is optional. It funds each new market's maker vault with 1,000 mUSDC instead
of the default 601, which leaves room for repeated open/close tests. The value
is in cents.

```text
# terminal 1, repository root (bash)
XYTHUM_SESSION_QUOTA=3 XYTHUM_ROOT_RESERVE_NEAR=5 XYTHUM_MAKER_VAULT_MUSDC=100000 node exchange/server/server.mjs
# PowerShell
$env:XYTHUM_SESSION_QUOTA='3'; $env:XYTHUM_ROOT_RESERVE_NEAR='5'; $env:XYTHUM_MAKER_VAULT_MUSDC='100000'; node exchange/server/server.mjs

# terminal 2, dev UI with /api proxied to 127.0.0.1:8790
cd exchange; npx vite
# or a production bundle served by the coordinator itself
cd exchange; npx vite build        # -> exchange/dist, served when XYTHUM_SERVE_DIST != 0
```

These are the main coordinator settings (`exchange/server/config.mjs`; the
full table is in [`exchange/server/README.md`](../exchange/server/README.md)).
Each spending value has a hard cap:

| Variable | Default | Bound |
| --- | --- | --- |
| `XYTHUM_SESSION_QUOTA` | unset = no new sessions | 1–50 total sessions |
| `XYTHUM_ROOT_RESERVE_NEAR` | 1 | ≤ 100. New sessions are refused if this much test NEAR would not remain on the root. |
| `XYTHUM_TRADER_NEAR` | 0.5 | ≤ 2 |
| `XYTHUM_TRADER_MUSDC` | 60,000 cents | 60,000–120,000 |
| `XYTHUM_MAKER_VAULT_MUSDC` | 60,100 cents | 60,100–240,400 |
| `XYTHUM_SETUP_QUEUE`, `XYTHUM_APPROVALS_PER_SESSION`, `XYTHUM_MARKS_PER_SESSION` | 4, 20, 100 | 16, 200, 1,000 |
| `XYTHUM_SESSION_DIR` | `.testnet/exchange-sessions` | must differ from `.testnet` and the proving directory |

`GET /api/health` reports the session count and the quota. Session records
hold public chain data and a SHA-256 of the bearer only
(`exchange/server/store.mjs`).

## Deploying later (not done)

There is no hosted deployment and no deployment config yet. These are the
constraints a deployment must meet:

- **One instance.** Run one always-on coordinator process. The Keeper B
  worker runs inside it, so it must keep running with no browser connected.
  The store takes an exclusive pid lock, so a second instance on the same
  directory will not start.
- **One persistent state volume.** Mount a single private volume holding the
  session directory, the proving directory, and the existing `.env`. If the
  session directory is lost, so are the quota accounting and the keeper
  arming state.
- **Hosted mode.** Hosted mode needs `XYTHUM_ALLOW_HOSTED=1` and an IP
  address in `XYTHUM_SERVER_HOST`. The creation cooldown then defaults to
  60 seconds per client address. Hosted mode limits creation by socket address
  only, so put an authenticating proxy in front before exposing it.
- **Same origin over HTTPS.** Serve `exchange/dist` and `/api` from the same
  origin behind HTTPS. The worker fetches the prover module and proving keys
  from its own origin, and WebCrypto needs a secure context.

## Next layers (not started)

Each of these is a separate layer on top of layer 1. None of them changes the
tagged layers, and none is claimed until it has its own testnet evidence.

- **Shorts.** A short side in the proof statements and the settlement model.
  This is expected to need new proving keys and a new market Wasm.
- **Margin edits.** Adding margin to, or removing it from, an open position
  without closing it.
- **Multiple slots.** More than one open position per trader on a market.
- **Shielded notes.** Private collateral notes in place of the public mUSDC
  claim, so deposits and withdrawals no longer reveal amounts.

Also still open: public hosting, an independent-operator trial with separate
keys for the maker, oracle, and keepers, proving on a real phone, and,
optionally, serving compressed proving keys.

## Design provenance

The user owns the original Xythum EVM DEX,
`Xythum-Labs/darkpool-gateway` at
`e5cbe25965ec546ac6e691704d9c176137cf561c`. The exchange UI reuses its
**layout and visual language only**:

- the 7/3 chart and trade-terminal grid;
- the header;
- the trading panel;
- the position and history tabs;
- the proof-progress messaging;
- the HSL palette.

The headers of `exchange/src/ui/exchange.js` and `exchange/src/ui/exchange.css`
list the source files. React, wagmi, TradingView, and wallet code were not
carried over. **No Solidity contracts or circuits from the EVM baseline were
reused.** The NEAR clearing contract and proof statements are new
([`docs/SPEC.md`](SPEC.md#baseline-and-scope)).
