# Xythum testnet exchange

`exchange/` is the consumer app. It has three parts: a browser client with an
in-browser Groth16 prover, a Vite UI, and a Node session coordinator
(`exchange/server/`). The coordinator provisions one trader account and one
isolated clearing market per visitor. It does this under the existing demo
root, with the existing maker, oracle, keepers, mock token, and proving keys
([`docs/TESTNET-ADDRESSES.md`](TESTNET-ADDRESSES.md)).

> **Status.** The code is still being integrated. No end-to-end browser run
> on testnet has been recorded, and there is no public hosted instance. This
> file describes the intended flow and the commands in the current sources. It
> reports no results. Paths and line numbers below refer to the draft sources
> and may move. The recorded testnet evidence is still the read-only replay in
> [`JUDGES.md`](../JUDGES.md).

## Using the app

1. **Start an account.** Open the app and choose start. The browser generates
   an Ed25519 key and keeps it in IndexedDB (`xythum-exchange`). It uses a
   non-extractable WebCrypto key where it can. Otherwise it falls back to a
   random secret in origin storage, and the UI shows this as `origin-storage`
   (`exchange/src/protocol/signer.js:1-5`). The browser sends only the public
   key to `POST /api/sessions`. The coordinator then creates
   `trader-<id>.<root>` holding only that key as full access, and it deploys
   and locks `market-<id>.<root>`. It also funds the maker vault, publishes a
   first oracle round, and sends the trader account test NEAR and
   60,000 mock-mUSDC cents (`exchange/server/coordinator.mjs:204-232`,
   `exchange/server/config.mjs:100-104`). The session bearer is returned once.
   Before signing anything, the browser checks the market configuration, the
   verifying-key digests, and the distinct roles on chain
   (`exchange/src/protocol/controller.js:255-279`). After a reload the session
   resumes automatically (`exchange/src/main.js:25-28`).
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

   The proving key downloads once per page load from `/api/proving/open.pk`,
   which can take a while.
5. **View receipts.** The Receipts tab lists each transaction with a
   `testnet.nearblocks.io` link. Transactions signed by the server (maker
   approval, oracle marks, Keeper B) show `final` only after the browser
   checks them at FINAL: the transaction must succeed, come from the expected
   signer, and call the expected method on this market. Otherwise they stay
   `unverified` (`controller.js:457-475`).
6. **Close and withdraw.** Close requests a fresh oracle round and proves
   `close` locally. It checks the refund against the local settlement model,
   then submits. Withdraw sends available mUSDC back to your trader account.
7. **Optional: deterministic mark.** The test tools publish a mark of your
   choice to *your session's market only*, in $10 ticks. Marks are limited by
   rate (`XYTHUM_MARK_INTERVAL_MS`), count (`XYTHUM_MARKS_PER_SESSION`), and
   range (`XYTHUM_MARK_MIN_TICKS`/`MAX_TICKS`). The UI can prefill a price just
   past liquidation.
8. **Optional: cold Keeper B.** Arming Keeper B tells the coordinator's
   background worker to watch your active slot. It attempts at most one proof
   per new oracle round, and the local prover refuses healthy positions before
   any transaction (`exchange/server/worker.mjs`,
   `coordinator.mjs:526-548`). If Keeper B liquidates first, your close is
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
  bodies are built from allowlists (`exchange/src/protocol/api.js:1-6`).
- **Settlement inference.** A close or liquidation publishes the refund and
  any bad debt. Together with size, entry, and the public mark, this lets an
  observer infer margin after settlement.
- **Browser-local custody, no recovery.** The signing key, the session bearer,
  and the sealed opening (AES-GCM under a non-extractable vault key,
  `exchange/src/protocol/store.js:1-5`) exist only in this browser origin.
  There is no export. If you clear site data or switch browser or profile, you
  lose the ability to sign deposits, withdrawals, and voluntary closes. The
  keepers can still liquidate from their encrypted copy if the mark crosses
  liquidation.

## Operator setup (local development)

**Requirements**

- Node **22.12 or later** and npm.
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

  Do not create, edit, or print these values
  (`exchange/server/testnet.mjs:171-281`). The existing `MARKET` key is used
  only to deploy and lock new session markets, and it is deleted from each
  new market in the same receipt.

**Install and build**, from the repository root:

```text
npm ci --ignore-scripts
npm ci --prefix exchange
rustup toolchain install 1.95.0 --target wasm32-unknown-unknown
cargo near build non-reproducible-wasm --locked --no-abi
cargo build --locked --manifest-path prover/Cargo.toml --release
```

The native build provides `target/near/xythum_near_perps.wasm`, which the
coordinator deploys per session (`config.mjs:95`). It also provides the native
prover that the keeper actors use (`tests/actor.mjs`, through
`exchange/server/actors.mjs`).

**Browser prover** (wasm-bindgen 0.2.130, installed under
`prover/target/tools` if missing). Both scripts `cd` into `prover/` before
writing their output, so pass an **absolute** output directory:

```text
bash prover/browser/build.sh "$PWD/exchange/public/prover"
powershell -File prover/browser/build.ps1 -OutDir "$PWD\exchange\public\prover"
```

The output is `xythum_prover.js`, `xythum_prover_bg.wasm`, the `.d.ts` files,
and `snippets/`, all Git-ignored. The worker imports
`/prover/xythum_prover.js` from its own origin
(`exchange/src/protocol/prover.worker.js:93`). Optionally, run the synthetic
smoke test with `node prover/browser/smoke.mjs exchange/public/prover`. It
creates fresh throwaway keys and never reads `.env` or `.testnet`.

**Proving inputs and verification.** The coordinator serves exactly two
public files from `XYTHUM_PROVING_DIR` (default `.testnet/proving/`):
`/api/proving/open.pk` and `/api/proving/close.pk`
(`exchange/server/app.mjs:20`).

- **At startup**, the coordinator requires `open.pk`, `close.pk`, and
  `liquidation.pk`. It re-derives the verifying keys and refuses to start
  unless their SHA-256 values match the deployment pins in
  `PINNED_VK_FINGERPRINTS` (`config.mjs:16-20`, `server.mjs:141-148`). If you
  set `XYTHUM_MARKET_WASM_SHA256`, it also checks the market Wasm.
- **In the browser**, the worker passes the on-chain `get_config()`
  `open_vk_sha256` and `close_vk_sha256` into the prover with the downloaded
  key.
- **To inspect a key by hand**, run
  `prover/target/release/xythum-browser-keys info .testnet/proving/open.pk`.
  It prints `vk_sha256`. The `compress` subcommand writes new
  `*.compressed.pk` files plus their download `sha256` and refuses to
  overwrite (`prover/browser/keys.rs:1-15`). The server does not serve
  compressed keys yet.

**Run.** Session creation is off unless you set a quota.

```text
# terminal 1, repository root (bash)
XYTHUM_SESSION_QUOTA=2 XYTHUM_ROOT_RESERVE_NEAR=5 node exchange/server/server.mjs
# PowerShell
$env:XYTHUM_SESSION_QUOTA='2'; $env:XYTHUM_ROOT_RESERVE_NEAR='5'; node exchange/server/server.mjs

# terminal 2, dev UI with /api proxied to 127.0.0.1:8790
cd exchange; npx vite
# or a production bundle served by the coordinator itself
cd exchange; npx vite build        # -> exchange/dist, served when XYTHUM_SERVE_DIST != 0
```

These are the coordinator's settings (`exchange/server/config.mjs:51-114`).
Each spending value has a hard cap:

| Variable | Default | Bound |
| --- | --- | --- |
| `XYTHUM_SESSION_QUOTA` | unset = no new sessions | 1–50 total sessions |
| `XYTHUM_ROOT_RESERVE_NEAR` | 1 | ≤ 100. New sessions are refused if this much test NEAR would not remain on the root. |
| `XYTHUM_TRADER_NEAR` | 0.5 | ≤ 2 |
| `XYTHUM_TRADER_MUSDC` / `XYTHUM_MAKER_VAULT_MUSDC` | 60,000 / 60,100 cents | ≤ 2× / 4× |
| `XYTHUM_SETUP_QUEUE`, `XYTHUM_APPROVALS_PER_SESSION`, `XYTHUM_MARKS_PER_SESSION` | 4, 20, 100 | 16, 200, 1,000 |
| `XYTHUM_SESSION_DIR` | `.testnet/exchange-sessions` | must differ from `.testnet` and the proving directory |

`GET /api/health` reports the session count and the quota. Session records
hold public chain data and a SHA-256 of the bearer only
(`exchange/server/store.mjs:1-3`).

## Pending browser enrollment addendum

Today `POST /api/sessions` accepts only `{ "public_key" }`
(`coordinator.mjs:135`). The expected addendum, which has not been
implemented, has two parts:

- **Proof of key possession.** The browser posts `public_key` together with
  an Ed25519 signature over a coordinator challenge, made with that key. The
  coordinator verifies the signature before it spends anything.
- **Pinned proving artifact.** The browser pins the digest of the public
  proving artifact it downloads, in addition to the on-chain `vk_sha256`
  check. For example, it could use the download `sha256` reported by
  `xythum-browser-keys compress`.

## Deploying later (not done)

There is no hosted deployment and no deployment config yet. These are the
constraints a deployment must meet:

- **One instance.** Run one always-on coordinator process. The Keeper B
  worker runs inside it, so it must keep running with no browser connected.
  The store also takes an exclusive pid lock (`store.mjs:272-290`), so a
  second instance on the same directory will not start.
- **One persistent state volume.** Mount a single private volume holding the
  session directory, the proving directory, and the existing `.env`. If the
  session directory is lost, so are the quota accounting and the keeper
  arming state.
- **Hosted mode.** Hosted mode needs `XYTHUM_ALLOW_HOSTED=1` and an IP
  address in `XYTHUM_SERVER_HOST` (`config.mjs:52-57`). The creation cooldown
  then defaults to 60 seconds per client address.
- **Same origin over HTTPS.** Serve `exchange/dist` and `/api` from the same
  origin behind HTTPS. The worker fetches the prover module and proving keys
  from its own origin, and WebCrypto needs a secure context.

## Pending work

- An end-to-end browser run on testnet: account, deposit, open, receipts,
  mark, Keeper B, close, and withdraw. It should be recorded in a new
  evidence file. Nothing is claimed until that exists.
- Public hosting.
- The enrollment addendum above.
- Optionally, serving compressed proving keys.

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

The UI header (`exchange/src/ui/exchange.js:3-12`) and the stylesheet header
(`exchange/src/ui/exchange.css:1-5`) list the source files. React, wagmi,
TradingView, and wallet code were not carried over. **No Solidity contracts
or circuits from the EVM baseline were reused.** The NEAR clearing contract and
proof statements are new ([`docs/SPEC.md`](SPEC.md#baseline-and-scope)).
