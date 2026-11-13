import { concat, fromBase58, fromBase64, fromUtf8, randomBytes, sha256, subtle, toBase64, toHex, utf8 } from './bytes.js';
import { Chain } from './chain.js';
import { failureReason, interpretOutcome, Rpc, TESTNET_RPC } from './rpc.js';
import { functionCall, ONE_YOCTO, TGAS } from './tx.js';
import { isAccountId } from './api.js';
import { usdToCents } from './model.js';
import { indexedDbBackend, Store } from './store.js';

const ZERO = new Uint8Array(32);
const ZERO_TEXT = toBase64(ZERO);
const DEPTH = 4;
const bytes = (s) => fromBase64(s, 32);
const hash = (prefix, ...parts) => sha256(utf8(prefix), ...parts);
const list = (v) => Array.from(v);
const note = (cents) => ({ cents, salt: list(randomBytes(32)) });
const two = (value) => Uint8Array.of(value & 255, value >>> 8);
const integer = (value, width) => {
  const data = new Uint8Array(width);
  const view = new DataView(data.buffer);
  if (width === 4) view.setUint32(0, value, true);
  else view.setBigUint64(0, BigInt(value), true);
  return data;
};

export async function noteFields(domain, owner, note) {
  const tag = await hash('QM:owner:2', owner);
  const inner = await hash('QM:note-inner:2', domain, tag, Uint8Array.from(note.salt));
  const leaf = await hash('QM:note-leaf:2', domain, inner, integer(note.cents, 8));
  const nullifier = await hash('QM:nullifier:2', domain, owner, leaf);
  return { inner: toBase64(inner), leaf: toBase64(leaf), nullifier: toBase64(nullifier), tag: toBase64(tag) };
}

export async function merklePath(leaves, index) {
  if (leaves.length > 2 ** DEPTH || index < 0 || index >= leaves.length) throw new Error('The note is absent from this root.');
  let row = Array.from({ length: 2 ** DEPTH }, (_, i) => leaves[i] ? bytes(leaves[i]) : ZERO);
  const siblings = [], right = [];
  for (let level = 0; level < DEPTH; level += 1) {
    siblings.push(list(row[index ^ 1]));
    right.push(Boolean(index & 1));
    const next = [];
    for (let i = 0; i < row.length; i += 2) next.push(hash('QM:branch:1', row[i], row[i + 1]));
    row = await Promise.all(next);
    index >>= 1;
  }
  return { siblings, right, root: toBase64(row[0]) };
}

function verifyWalletTransaction(result) {
  const hash = result?.transaction?.hash ?? result?.transactionHash;
  if (typeof hash !== 'string') throw new Error('The wallet returned no transaction hash.');
  return hash;
}

export class PoolClient {
  constructor({ account, wallet, trader, pool, token, journalStore, prove, rpc = new Rpc(TESTNET_RPC) }) {
    if (![account, pool, token].every(isAccountId)) throw new Error('Invalid pool configuration.');
    Object.assign(this, { account, wallet, trader, pool, token, journalStore, prove, rpc });
    this.key = 'pool-notes:' + pool;
  }

  async initialize() {
    const { signer } = this.trader;
    this.privateAccount = toHex(fromBase58(signer.publicKey.slice(8)));
    const store = this.journalStore ?? new Store(indexedDbBackend('quiet-margin-pool-tx:' + this.pool + ':' + this.privateAccount));
    this.chain = new Chain({ rpc: this.rpc, store, signer, accountId: this.privateAccount,
      broadcastWaitUntil: 'EXECUTED_OPTIMISTIC' });
    await this.exclusive(() => this.chain.resolveJournal());
    const state = await this.state();
    if (state.token !== this.token) throw new Error('This pool uses a different token.');
    this.domain = bytes(state.domain);
    this.owner = await sha256(await signer.sign(concat(utf8('Quiet Margin private collateral v2:'), this.domain)));
    return this.read();
  }

  state() { return this.rpc.view(this.pool, 'get_pool'); }
  records() { return this.trader.store.getSealed(this.key).then((records) => records ?? { notes: [], positions: [] }); }
  save(records) { return this.trader.store.putSealed(this.key, records); }

  exclusive(run) {
    return globalThis.navigator?.locks
      ? navigator.locks.request(this.key + ':' + this.privateAccount, { ifAvailable: true }, (lock) => {
        if (!lock) throw new Error('A pool action is in progress in another tab.');
        return run();
      }) : run();
  }

  async gasReady() {
    try {
      const [key, account] = await Promise.all([
        this.rpc.viewAccessKey(this.privateAccount, this.trader.signer.publicKey),
        this.rpc.call('query', { request_type: 'view_account', account_id: this.privateAccount, finality: 'final' }),
      ]);
      return key.permission === 'FullAccess' && BigInt(account.amount) >= 5n * 10n ** 22n;
    } catch (error) {
      if (/UNKNOWN_ACCOUNT|UNKNOWN_ACCESS_KEY|does not exist/i.test(error.message)) return false;
      throw error;
    }
  }

  backupKey() {
    return subtle().importKey('raw', this.owner, 'HKDF', false, ['deriveKey']).then((key) => subtle().deriveKey({
      name: 'HKDF', hash: 'SHA-256', salt: this.domain, info: utf8('Quiet Margin pool backup v1'),
    }, key, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']));
  }

  async exportBackup() {
    const iv = randomBytes(12);
    const body = await subtle().encrypt({ name: 'AES-GCM', iv, additionalData: utf8(this.key) },
      await this.backupKey(), utf8(JSON.stringify(await this.records())));
    return JSON.stringify({ version: 1, pool: this.pool, iv: toBase64(iv), body: toBase64(new Uint8Array(body)) });
  }

  async importBackup(text) {
    const data = JSON.parse(text);
    if (data.version !== 1 || data.pool !== this.pool || text.length > 500_000) throw new Error('Use a backup for this pool.');
    let backup;
    try {
      const plain = await subtle().decrypt({ name: 'AES-GCM', iv: fromBase64(data.iv, 12), additionalData: utf8(this.key) },
        await this.backupKey(), fromBase64(data.body));
      backup = JSON.parse(fromUtf8(new Uint8Array(plain)));
    } catch {
      throw new Error('This backup could not be opened with the connected wallet.');
    }
    const records = await this.records();
    const merge = (items, incoming, key) => [...new Map([...incoming, ...items].map((item) => [key(item), item])).values()];
    await this.save({ notes: merge(records.notes, backup.notes, (item) => item.salt.join(',')),
      positions: merge(records.positions, backup.positions, (item) => item.commitment) });
  }

  async read() {
    const [state, records, wallet] = await Promise.all([
      this.state(), this.records(), this.rpc.view(this.token, 'ft_balance_of', { account_id: this.account }),
    ]);
    const owned = await Promise.all(records.notes.map(async (note) => ({ note, ...await noteFields(this.domain, this.owner, note) })));
    const live = owned.filter((n) => state.leaves.includes(n.leaf) && !state.spent.includes(n.nullifier));
    return { state, records, live, wallet: Number(wallet),
      balance: live.reduce((sum, { note }) => sum + note.cents, 0),
      position: records.positions.find((p) => state.positions.includes(p.commitment)),
    };
  }

  async deposit(value) {
    const cents = usdToCents(value, { max: 1_000_000 });
    const fresh = note(cents);
    const fields = await noteFields(this.domain, this.owner, fresh);
    const records = await this.records();
    records.notes.push(fresh);
    await this.save(records);
    const actions = [functionCall('ft_transfer_call', {
      receiver_id: this.pool, amount: String(cents), msg: fields.inner,
    }, { gas: 75n * TGAS, deposit: ONE_YOCTO })];
    const hash = verifyWalletTransaction(await this.wallet.signAndSendTransaction({
      network: 'testnet', signerId: this.account, receiverId: this.token, actions,
    }));
    const outcome = interpretOutcome(await this.rpc.txFinal(hash, this.account));
    if (!outcome.ok) throw new Error('Deposit failed: ' + failureReason(outcome.failures));
    if (!(await this.state()).leaves.includes(fields.leaf)) throw new Error('The pool returned the deposit.');
    return hash;
  }

  async prepareSpend(cents) {
    const view = await this.read();
    const notes = view.live;
    let selected = notes.find((n) => n.note.cents === cents);
    let pair;
    if (!selected) {
      for (const [i, first] of notes.entries()) {
        const second = notes.slice(i + 1).find((n) => first.note.cents + n.note.cents >= cents);
        if (second) { pair = [first, second]; break; }
      }
      selected = notes.find((n) => n.note.cents >= cents);
    }
    const chosen = pair ?? (selected ? [selected] : []);
    if (!chosen.length) throw new Error('This action needs one or two notes that cover the amount.');
    const change = note(chosen.reduce((sum, n) => sum + n.note.cents, 0) - cents);
    const changeLeaf = change.cents ? (await noteFields(this.domain, this.owner, change)).leaf : ZERO_TEXT;
    const inputs = await Promise.all(chosen.map(async (n) => {
      const path = await merklePath(view.state.leaves, view.state.leaves.indexOf(n.leaf));
      if (path.root !== view.state.root) throw new Error('The pool root could not be verified.');
      return { note: n.note, siblings: path.siblings, right: path.right };
    }));
    if (inputs.length === 1) inputs.push({ note: { cents: 0, salt: list(ZERO) }, siblings: Array.from({ length: DEPTH }, () => list(ZERO)), right: Array(DEPTH).fill(false) });
    if (change.cents) view.records.notes.push(change);
    const witness = { domain: list(this.domain), root: list(bytes(view.state.root)), owner: list(this.owner),
      inputs, two_inputs: chosen.length === 2, change };
    const args = { root: view.state.root, nullifiers: [chosen[0].nullifier, chosen[1]?.nullifier ?? ZERO_TEXT], change: changeLeaf };
    return { view, witness, args };
  }

  async open(value, lots = 1) {
    const margin = usdToCents(value, { max: 60_000 });
    const { view, witness, args } = await this.prepareSpend(margin);
    const entry = view.state.price_ticks;
    if (!Number.isInteger(lots) || lots < 1 || lots > 50 || !entry || entry * lots > 3 * margin) {
      throw new Error('The position must fit the 3× leverage cap at the NEAR mark.');
    }
    const context = randomBytes(32), blinder = randomBytes(32);
    const commitment = toBase64(await sha256(context, blinder, two(lots), two(entry), integer(margin, 4)));
    const position = { commitment, context: list(context), blinder: list(blinder), entry, lots, margin };
    view.records.positions.push(position);
    await this.save(view.records);
    const { tag } = await noteFields(this.domain, this.owner, witness.change);
    const proof = await this.prove('spend', view.state.spend_vk_sha256, {
      ...witness, context: position.context, blinder: position.blinder, lots, entry, margin, withdraw: 0, recipient: list(ZERO),
    });
    return this.call('open_private', { ...args, commitment, context: toBase64(context), owner_tag: tag, entry_ticks: entry, proof });
  }

  async close() {
    const { position, records, state } = await this.read();
    if (!position) throw new Error('No position is available to close in this wallet.');
    const pnl = Math.min((state.price_ticks - position.entry) * position.lots, 60_000);
    const payout = note(Math.max(0, position.margin + pnl));
    const maker_credit = 60_000 + position.margin - payout.cents;
    const leaf = payout.cents ? (await noteFields(this.domain, this.owner, payout)).leaf : ZERO_TEXT;
    if (payout.cents) records.notes.push(payout);
    await this.save(records);
    const { commitment, ...opening } = position;
    const proof = await this.prove('close', state.close_vk_sha256, {
      ...opening, domain: list(this.domain), owner: list(this.owner), price: state.price_ticks, round: state.round, payout,
    });
    return this.call('close_private', { commitment, round: state.round, payout: leaf, maker_credit: String(maker_credit), proof });
  }

  async withdraw(value, recipient) {
    if (!isAccountId(recipient)) throw new Error('Enter a valid NEAR testnet recipient.');
    const cents = usdToCents(value);
    const { view, witness, args } = await this.prepareSpend(cents);
    await this.save(view.records);
    const target = await hash('QM:exit:2:', utf8(recipient));
    const proof = await this.prove('spend', view.state.spend_vk_sha256, {
      ...witness, context: list(ZERO), blinder: list(ZERO), lots: 0, entry: 0, margin: 0,
      withdraw: cents, recipient: list(target),
    });
    return this.call('withdraw_private', { ...args, recipient, amount: String(cents), proof }, ONE_YOCTO);
  }

  async call(method, args, deposit = 0n) {
    await this.chain.resolveJournal();
    const result = await this.chain.call(method, this.pool, [functionCall(method, args, { gas: 120n * TGAS, deposit })]);
    return result.hash;
  }
}
