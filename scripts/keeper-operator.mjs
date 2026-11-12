// Independent Keeper B operator CLI. See docs/INDEPENDENT-KEEPER.md.
//
// Offline commands (init, manifest, check-manifest, self-test) use only
// node:crypto and never load the NEAR client. Online commands (check, ack,
// liquidate) talk to NEAR testnet through scripts/testnet-client.mjs and the
// existing tests/actor.mjs. Private keys are only ever read from the local
// key file; they are never accepted as arguments or written to stdout.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { Console } from 'node:console';
import {
  createHash, createPrivateKey, createPublicKey, diffieHellman, generateKeyPairSync, sign, verify,
} from 'node:crypto';
import {
  closeSync, existsSync, fsyncSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, statSync, unlinkSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const KEEPER_INDEX = 1;
// KEY_VERSION in src/lib.rs; the last four bytes of every acknowledgment message.
const ACK_KEY_VERSION = 1;
const KEYS_SCHEMA = 'xythum-keeper-keys/v1';
const MANIFEST_SCHEMA = 'xythum-keeper-manifest/v1';
const ACK_SCHEMA = 'xythum-keeper-ack/v1';
const LIQUIDATION_SCHEMA = 'xythum-keeper-liquidation/v1';
const KEYS_SUFFIX = '.keeper-keys.json';
const KEY_FIELDS = ['account_id', 'encryption', 'keeper_index', 'network', 'schema', 'signing', 'txKey'];
const MANIFEST_FIELDS = [
  'account_id', 'ack_key', 'encryption_key', 'keeper_index', 'network', 'role', 'schema', 'tx_public_key',
];
const VK_KINDS = ['open', 'liquidation', 'close'];
// DER headers for raw 32-byte keys.
const ED25519_PKCS8 = Buffer.from('302e020100300506032b657004220420', 'hex');
const ED25519_SPKI = Buffer.from('302a300506032b6570032100', 'hex');
const X25519_SPKI = Buffer.from('302a300506032b656e032100', 'hex');
const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
// Principals a Windows key file ACL may name; anything else fails closed.
const WINDOWS_TRUSTED = ['NT AUTHORITY\\SYSTEM', 'BUILTIN\\Administrators'];
const scriptPath = fileURLToPath(import.meta.url);
const repoRoot = fileURLToPath(new URL('..', import.meta.url));

const b64 = (value) => value.toString('base64');
const sha256 = (value) => createHash('sha256').update(value).digest();
const le32 = (value) => {
  const out = Buffer.alloc(4);
  out.writeUInt32LE(value);
  return out;
};

function base58(bytes) {
  let n = BigInt('0x0' + bytes.toString('hex'));
  let out = '';
  while (n > 0n) {
    out = B58[Number(n % 58n)] + out;
    n /= 58n;
  }
  for (const byte of bytes) {
    if (byte !== 0) break;
    out = '1' + out;
  }
  return out;
}

function unbase58(text) {
  let n = 0n;
  for (const char of text) {
    const digit = B58.indexOf(char);
    if (digit < 0) throw new Error('invalid base58');
    n = n * 58n + BigInt(digit);
  }
  let hex = n === 0n ? '' : n.toString(16);
  if (hex.length % 2) hex = '0' + hex;
  const zeros = /^1*/.exec(text)[0].length;
  return Buffer.concat([Buffer.alloc(zeros), Buffer.from(hex, 'hex')]);
}

function canonicalBase64(text, length, name) {
  assert.equal(typeof text, 'string', name + ' must be a string');
  const raw = Buffer.from(text, 'base64');
  assert.ok(b64(raw) === text && raw.length === length, name + ' must be ' + length + ' canonical Base64 bytes');
  return raw;
}

function testnetId(value, name) {
  assert.ok(typeof value === 'string' && value.length <= 64
    && /^(?:[a-z0-9]+(?:[-_][a-z0-9]+)*\.)+testnet$/.test(value), name + ' must be a named .testnet account');
  return value;
}

const rawEd25519 = (key) => key.export({ type: 'spki', format: 'der' }).subarray(-32);
const ed25519Public = (raw) => createPublicKey({ key: Buffer.concat([ED25519_SPKI, raw]), type: 'spki', format: 'der' });
const pkcs8 = (text, type) => {
  const key = createPrivateKey({ key: Buffer.from(text, 'base64'), type: 'pkcs8', format: 'der' });
  assert.equal(key.asymmetricKeyType, type, 'key file holds a wrong ' + type + ' key');
  return key;
};

function nearPublicKey(text) {
  assert.ok(typeof text === 'string' && /^ed25519:[1-9A-HJ-NP-Za-km-z]+$/.test(text),
    'tx_public_key must be ed25519:<base58>');
  const raw = unbase58(text.slice(8));
  assert.ok(raw.length === 32 && 'ed25519:' + base58(raw) === text, 'tx_public_key must encode 32 bytes');
  ed25519Public(raw);
  return raw;
}

// The NEAR transaction key uses the near-api-js "ed25519:<base58(seed || public)>" format.
function txPublicKey(txKey) {
  assert.ok(typeof txKey === 'string' && txKey.startsWith('ed25519:'), 'txKey must be an ed25519 key');
  const raw = unbase58(txKey.slice(8));
  assert.equal(raw.length, 64, 'txKey must hold 64 bytes');
  const derived = rawEd25519(createPublicKey(createPrivateKey({
    key: Buffer.concat([ED25519_PKCS8, raw.subarray(0, 32)]), type: 'pkcs8', format: 'der',
  })));
  assert.ok(derived.equals(raw.subarray(32)), 'txKey public half does not match its seed');
  return 'ed25519:' + base58(derived);
}

function keysPath(path) {
  assert.ok(typeof path === 'string' && path.endsWith(KEYS_SUFFIX), '--keys must end with ' + KEYS_SUFFIX);
  return resolve(path);
}

function generateKeys(accountId) {
  const tx = generateKeyPairSync('ed25519');
  const seed = tx.privateKey.export({ type: 'pkcs8', format: 'der' }).subarray(-32);
  const der = (key) => b64(key.export({ type: 'pkcs8', format: 'der' }));
  // Field names match what tests/actor.mjs reads: encryption, signing, txKey.
  return {
    schema: KEYS_SCHEMA, network: 'testnet', account_id: accountId, keeper_index: KEEPER_INDEX,
    txKey: 'ed25519:' + base58(Buffer.concat([seed, rawEd25519(tx.publicKey)])),
    encryption: der(generateKeyPairSync('x25519').privateKey),
    signing: der(generateKeyPairSync('ed25519').privateKey),
  };
}

// Read-only Windows ACL inspection with icacls. Every entry must name the
// current user, SYSTEM or Administrators; output that cannot be parsed fails.
const windowsUser = () => process.env.USERDOMAIN + '\\' + process.env.USERNAME;

function windowsAclCheck(file,
  fix = 'restrict it with: icacls "' + file + '" /inheritance:r /grant:r "' + windowsUser() + ':F"') {
  const child = spawnSync('icacls', [file], { encoding: 'utf8', windowsHide: true, timeout: 30_000 });
  assert.ok(!child.error && child.status === 0, 'icacls could not read the key file ACL; ' + fix);
  const trusted = [windowsUser(), ...WINDOWS_TRUSTED].map((name) => name.toLowerCase());
  const lines = child.stdout.replace(/\r/g, '').split('\n');
  assert.ok(lines[0].toLowerCase().startsWith(file.toLowerCase()), 'unexpected icacls output; ' + fix);
  lines[0] = lines[0].slice(file.length);
  const entries = [];
  for (const line of lines) {
    if (!line.trim()) break;
    const match = /^(.+?):((?:\([^)]*\))+)$/.exec(line.trim());
    assert.ok(match, 'unexpected icacls entry "' + line.trim() + '"; ' + fix);
    entries.push(match[1]);
  }
  assert.ok(entries.length > 0, 'icacls listed no ACL entries; ' + fix);
  const others = entries.filter((name) => !trusted.includes(name.toLowerCase()));
  assert.equal(others.length, 0, 'key file ACL also grants ' + others.join(', ') + '; ' + fix);
}

function loadKeys(path) {
  const file = keysPath(path);
  if (process.platform === 'win32') windowsAclCheck(file);
  else assert.equal(statSync(file).mode & 0o077, 0, 'key file must not be readable by group or others');
  const keys = JSON.parse(readFileSync(file, 'utf8'));
  assert.deepEqual(Object.keys(keys).sort(), KEY_FIELDS, 'unexpected key file fields');
  assert.equal(keys.schema, KEYS_SCHEMA);
  assert.equal(keys.network, 'testnet');
  assert.equal(keys.keeper_index, KEEPER_INDEX);
  testnetId(keys.account_id, 'account_id');
  return { file, keys, manifest: publicManifest(keys) };
}

function publicManifest(keys) {
  return {
    schema: MANIFEST_SCHEMA, network: 'testnet', role: 'KEEPER_B', keeper_index: KEEPER_INDEX,
    account_id: keys.account_id,
    tx_public_key: txPublicKey(keys.txKey),
    encryption_key: b64(createPublicKey(pkcs8(keys.encryption, 'x25519')).export({ type: 'spki', format: 'der' })),
    ack_key: b64(rawEd25519(createPublicKey(pkcs8(keys.signing, 'ed25519')))),
  };
}

// Coordinator-side validation of the public manifest a Keeper B operator sends.
function validateManifest(manifest, coordinator) {
  assert.ok(manifest && typeof manifest === 'object' && !Array.isArray(manifest), 'manifest must be an object');
  assert.deepEqual(Object.keys(manifest).sort(), MANIFEST_FIELDS, 'manifest must hold exactly the public fields');
  assert.equal(manifest.schema, MANIFEST_SCHEMA);
  assert.equal(manifest.network, 'testnet');
  assert.equal(manifest.role, 'KEEPER_B');
  assert.equal(manifest.keeper_index, KEEPER_INDEX);
  const account = testnetId(manifest.account_id, 'account_id');
  if (coordinator !== undefined) {
    testnetId(coordinator, '--coordinator');
    assert.ok(account !== coordinator && !account.endsWith('.' + coordinator),
      'Keeper B must not be the coordinator account or one of its subaccounts');
  }
  const tx = nearPublicKey(manifest.tx_public_key);
  const encryption = canonicalBase64(manifest.encryption_key, 44, 'encryption_key');
  assert.ok(encryption.subarray(0, 12).equals(X25519_SPKI), 'encryption_key must be an X25519 SPKI key');
  assert.equal(createPublicKey({ key: encryption, type: 'spki', format: 'der' }).asymmetricKeyType, 'x25519');
  const ack = canonicalBase64(manifest.ack_key, 32, 'ack_key');
  ed25519Public(ack);
  assert.ok(!ack.equals(tx), 'ack_key must differ from tx_public_key');
  return {
    keeper: { account_id: account, ack_key: manifest.ack_key },
    encryption_key: manifest.encryption_key,
    tx_public_key: manifest.tx_public_key,
  };
}

function ackMessage(domain, pending) {
  return Buffer.concat([
    Buffer.from('xythum:keeper-ack:v2:', 'ascii'), Buffer.from(domain, 'base64'), le32(pending.nonce),
    Buffer.from(pending.commitment, 'base64'), sha256(Buffer.from(pending.ciphertexts[KEEPER_INDEX], 'base64')),
    Buffer.from([KEEPER_INDEX]), le32(ACK_KEY_VERSION),
  ]);
}

const reason = (error) => (error.code === 'EEXIST' ? 'already exists'
  : 'cannot be created (' + (error.code ?? error.message) + ')');

// Output files are reserved exclusively before any key generation, network
// read or signing, so a bad or existing path stops the command first.
function reserve(path, flag) {
  if (path === undefined) return undefined;
  const file = resolve(path);
  try {
    return { file, fd: openSync(file, 'wx'), done: false };
  } catch (error) {
    throw new Error(flag + ' ' + file + ' ' + reason(error) + '.'
      + ' Nothing was generated, signed or sent. Choose a new path in an existing directory.');
  }
}

// Failure cleanup: removes a reservation nothing was written to.
function release(sink) {
  if (!sink || sink.done) return;
  sink.done = true;
  try { closeSync(sink.fd); } catch { /* already closed */ }
  try { unlinkSync(sink.file); } catch { /* already gone */ }
}

// The result goes to stdout first, so it survives any file write error.
function output(value, sink, recovery = 'Save the JSON printed on stdout.') {
  const text = JSON.stringify(value, null, 2) + '\n';
  process.stdout.write(text);
  if (!sink) return;
  sink.done = true;
  try {
    writeFileSync(sink.fd, text);
    fsyncSync(sink.fd);
    closeSync(sink.fd);
  } catch (error) {
    try { closeSync(sink.fd); } catch { /* already closed */ }
    try { unlinkSync(sink.file); } catch { /* already gone */ }
    throw new Error('The JSON on stdout is the complete result, but writing ' + sink.file + ' failed ('
      + error.message + ') and the partial file was removed. ' + recovery);
  }
}

// Runs a command with its output file reserved, releasing it on failure.
async function withOutput(path, flag, body) {
  const sink = reserve(path, flag);
  try {
    return await body(sink);
  } finally {
    release(sink);
  }
}

// --- Commands -------------------------------------------------------------

function init({ account, keys, manifest }) {
  const accountId = testnetId(account, '--account');
  const file = keysPath(keys);
  assert.ok(manifest, '--manifest is required');
  assert.ok(!existsSync(file), file + ' already exists');
  return withOutput(manifest, '--manifest', (sink) => {
    const generated = generateKeys(accountId);
    const publicView = publicManifest(generated);
    let fd;
    try {
      fd = openSync(file, 'wx', 0o600);
    } catch (error) {
      throw new Error('--keys ' + file + ' ' + reason(error) + '.'
        + ' No key file or manifest was written. Choose a new path in an existing directory.');
    }
    if (process.platform === 'win32') {
      // The exclusive file is still empty: check the ACL it inherited before any secret byte is written.
      const dir = dirname(file);
      try {
        windowsAclCheck(file, 'restrict the directory with: icacls "' + dir + '" /inheritance:r /grant:r "'
          + windowsUser() + ':(OI)(CI)F" and rerun init');
      } catch (error) {
        try { closeSync(fd); } catch { /* already closed */ }
        rmSync(file, { force: true });
        throw new Error('--keys ' + file + ' would inherit an unsafe ACL: ' + error.message.split('\n')[0]
          + '. Nothing was written; the empty key file and the manifest reservation were removed.');
      }
    }
    try {
      writeFileSync(fd, JSON.stringify(generated) + '\n');
      fsyncSync(fd);
      closeSync(fd);
    } catch (error) {
      try { closeSync(fd); } catch { /* already closed */ }
      rmSync(file, { force: true });
      throw new Error('writing ' + file + ' failed (' + error.message + '); the partial key file and the'
        + ' manifest reservation were removed. Rerun init.');
    }
    output(publicView, sink, 'The key file ' + file + ' is complete and holds the new keys. Do not rerun init.'
      + ' Recreate the manifest with: node scripts/keeper-operator.mjs manifest --keys "' + file + '" --out <new path>');
  });
}

function exportManifest({ keys, out }) {
  return withOutput(out, '--out', (sink) => output(loadKeys(keys).manifest, sink));
}

function checkManifest({ manifest, coordinator, out }) {
  assert.ok(manifest, '--manifest is required');
  assert.ok(coordinator, '--coordinator is required');
  return withOutput(out, '--out',
    (sink) => output(validateManifest(JSON.parse(readFileSync(manifest, 'utf8')), coordinator), sink));
}

async function connect({ keys, market }) {
  const marketId = testnetId(market, '--market');
  const local = loadKeys(keys);
  const client = await import('./testnet-client.mjs');
  const actorModule = await import('../tests/actor.mjs');
  const chain = await client.connectChain(client.TESTNET_RPC, true);
  const view = (method, args) => client.viewFinal(chain, marketId, method, args);
  const config = await view('get_config');
  assert.deepEqual(config.keepers[KEEPER_INDEX],
    { account_id: local.manifest.account_id, ack_key: local.manifest.ack_key },
    'the market does not register this key file as Keeper B');
  assert.equal(config.key_version, ACK_KEY_VERSION,
    'the market acknowledgment key version differs from the version this tool signs');
  const actorInput = {
    testnet: true, rpcAddr: client.TESTNET_RPC, contractId: marketId, trader: config.trader_id,
    accountId: local.manifest.account_id, keeperIndex: KEEPER_INDEX, keyPath: local.file,
  };
  return { ...actorModule, chain, config, view, local, marketId, actorInput };
}

function checkProving(prover, provingDir, config) {
  const keys = prover('keys', resolve(provingDir));
  for (const kind of VK_KINDS) {
    assert.equal(keys[kind + '_vk_sha256'], config[kind + '_vk_sha256'],
      kind + ' verifying-key fingerprint differs from the deployed market');
  }
  return Object.fromEntries(VK_KINDS.map((kind) => [kind, keys[kind + '_vk_sha256']]));
}

async function checkAccessKey(chain, manifest, marketId) {
  const key = await chain.provider.query({
    request_type: 'view_access_key', finality: 'final',
    account_id: manifest.account_id, public_key: manifest.tx_public_key,
  });
  const call = key.permission.FunctionCall;
  assert.ok(key.permission === 'FullAccess' || (call && call.receiver_id === marketId
    && (call.method_names.length === 0 || call.method_names.includes('liquidate'))),
  'the transaction key cannot call liquidate on ' + marketId);
  const account = await chain.provider.query({
    request_type: 'view_account', finality: 'final', account_id: manifest.account_id,
  });
  return { permission: key.permission, balance_yocto: account.amount };
}

function check(flags) {
  return withOutput(flags.out, '--out', async (sink) => {
    const ctx = await connect(flags);
    output({
      network: 'testnet', market: ctx.marketId, keeper_index: KEEPER_INDEX, keeper: ctx.config.keepers[KEEPER_INDEX],
      verifying_key_sha256: checkProving(ctx.prover, flags.proving, ctx.config),
      access_key: await checkAccessKey(ctx.chain, ctx.local.manifest, ctx.marketId),
      pending_nonce: (await ctx.view('get_pending'))?.nonce ?? null,
      active_nonce: (await ctx.view('get_active'))?.nonce ?? null,
    }, sink);
  });
}

function ack(flags) {
  return withOutput(flags.out, '--out', async (sink) => {
    const ctx = await connect(flags);
    const pending = await ctx.view('get_pending');
    assert.ok(pending, 'the market has no staged position');
    const domain = await ctx.view('get_market');
    // actor('ack') decrypts the exact on-chain ciphertext, checks the witness
    // commitment and signs. The signature is then checked against the slot
    // read here, so the record always describes the acknowledged ciphertext.
    const { signature } = ctx.actor('ack', ctx.actorInput);
    const ackKey = ed25519Public(Buffer.from(ctx.local.manifest.ack_key, 'base64'));
    assert.ok(verify(null, ackMessage(domain, pending), ackKey, Buffer.from(signature, 'base64')),
      'the staged position changed during acknowledgment; rerun ack');
    output({
      schema: ACK_SCHEMA, network: 'testnet', market: ctx.marketId, market_domain: domain,
      keeper_index: KEEPER_INDEX, keeper_account: ctx.local.manifest.account_id,
      nonce: pending.nonce, commitment: pending.commitment,
      ciphertext_sha256: b64(sha256(Buffer.from(pending.ciphertexts[KEEPER_INDEX], 'base64'))),
      signature,
    }, sink, 'Send the JSON printed on stdout to the coordinator as the ack record.');
  });
}

// Printed when actor('liquidate') fails: the transaction may already be on chain.
function liquidationRecovery(flags, nonce) {
  const base = 'node scripts/keeper-operator.mjs';
  const args = '--keys "' + resolve(flags.keys) + '" --market ' + flags.market
    + ' --proving "' + resolve(flags.proving) + '"';
  return [
    'Liquidation outcome is UNCERTAIN: the transaction may have been signed and submitted before this error.',
    'Keep the key file, do not delete anything, and recover in this order.',
    '1. Wait one minute, then run: ' + base + ' check ' + args + ' --out <new path>',
    '2. If active_nonce is null, position ' + nonce + ' was settled. Find the liquidate transaction in the'
      + ' Keeper B account history and confirm its signer is the Keeper B account and its final status is'
      + ' success; get_ledger().keeper_available[1] holds the bounty. If another account settled it, there is'
      + ' no Keeper B liquidation to record. Do not resubmit.',
    '3. If active_nonce is still ' + nonce + ', nothing settled. Rerun ' + base + ' liquidate ' + args
      + ' --dry-run, then without --dry-run with a new --out path. A duplicate cannot settle twice:'
      + ' the contract rejects a second settlement with ERR_NO_ACTIVE.',
  ].join('\n');
}

function liquidate(flags) {
  return withOutput(flags.out, '--out', async (sink) => {
    const ctx = await connect(flags);
    const fingerprints = checkProving(ctx.prover, flags.proving, ctx.config);
    await checkAccessKey(ctx.chain, ctx.local.manifest, ctx.marketId);
    const active = await ctx.view('get_active');
    assert.ok(active, 'the market has no active position to liquidate');
    const input = { ...ctx.actorInput, provingDir: resolve(flags.proving) };
    let result;
    try {
      result = ctx.actor(flags['dry-run'] ? 'prove' : 'liquidate', input);
    } catch (error) {
      if (flags['dry-run']) throw error;
      throw new Error(error.message.trim() + '\n' + liquidationRecovery(flags, active.nonce));
    }
    output({
      schema: LIQUIDATION_SCHEMA, network: 'testnet', market: ctx.marketId, submitted: !flags['dry-run'],
      keeper_account: ctx.local.manifest.account_id, verifying_key_sha256: fingerprints, ...result,
    }, sink, flags['dry-run'] ? undefined : 'The transaction is final. Do not resubmit; publish the JSON on stdout'
      + ' as the liquidation record.');
  });
}

// --- Offline self-test ------------------------------------------------------

// Loaded into every child process: any socket connection throws.
const NETWORK_GUARD = 'data:text/javascript,' + encodeURIComponent(
  "import net from 'node:net';"
  + "const blocked = () => { throw new Error('network disabled in self-test'); };"
  + 'net.Socket.prototype.connect = blocked; globalThis.fetch = blocked;',
);

function selfTest() {
  const dir = mkdtempSync(join(tmpdir(), 'xythum-keeper-selftest-'));
  const run = (...args) => spawnSync(process.execPath, ['--import', NETWORK_GUARD, ...args],
    { cwd: dir, encoding: 'utf8', timeout: 60_000 });
  const cli = (...args) => run(scriptPath, ...args);
  const ok = (child) => {
    assert.equal(child.status, 0, child.stderr);
    return child.stdout;
  };
  const fails = (child, pattern) => {
    assert.equal(child.status, 1, child.stdout);
    assert.match(child.stderr, pattern);
  };
  const icacls = (...args) => {
    const child = spawnSync('icacls', args, { encoding: 'utf8', windowsHide: true });
    assert.equal(child.status, 0, child.stdout + child.stderr);
  };
  const results = [];
  const step = (name, body) => {
    body();
    results.push(name);
  };
  try {
    // A private temp directory, so the key file init creates inherits only the current user.
    if (process.platform === 'win32') icacls(dir, '/inheritance:r', '/grant:r', windowsUser() + ':(OI)(CI)F');
    const keyFile = join(dir, 'operator.keeper-keys.json');
    const manifestFile = join(dir, 'operator.manifest.json');
    const outputs = [];
    let keys;
    let manifest;

    step('network guard blocks sockets', () => fails(
      run('-e', "require('node:net').connect(9, '127.0.0.1')"), /network disabled/));

    step('init writes a private key file and a public manifest', () => {
      const stdout = ok(cli('init', '--account', 'keeper-op.testnet', '--keys', keyFile, '--manifest', manifestFile));
      outputs.push(stdout);
      keys = JSON.parse(readFileSync(keyFile, 'utf8'));
      manifest = JSON.parse(readFileSync(manifestFile, 'utf8'));
      assert.deepEqual(JSON.parse(stdout), manifest);
      assert.deepEqual(Object.keys(keys).sort(), KEY_FIELDS);
      if (process.platform !== 'win32') assert.equal(statSync(keyFile).mode & 0o777, 0o600);
    });

    if (process.platform === 'win32') {
      step('Windows init refuses an inherited unsafe ACL before writing any key', () => {
        const shared = join(dir, 'shared');
        mkdirSync(shared);
        icacls(shared, '/grant', '*S-1-1-0:(OI)(CI)(R)');
        const file = join(shared, 'k' + KEYS_SUFFIX);
        const out = join(shared, 'm.json');
        fails(cli('init', '--account', 'keeper-op.testnet', '--keys', file, '--manifest', out),
          /would inherit an unsafe ACL: .*ACL also grants .*icacls ".*shared" \/inheritance:r .*Nothing was written/);
        assert.ok(!existsSync(file) && !existsSync(out), 'a refused init left a file behind');
      });

      step('Windows key file ACL is checked read-only with icacls', () => {
        icacls(keyFile, '/grant', '*S-1-1-0:(R)');
        fails(cli('manifest', '--keys', keyFile), /ACL also grants .*icacls ".*" \/inheritance:r \/grant:r/);
        icacls(keyFile, '/remove:g', '*S-1-1-0');
        ok(cli('manifest', '--keys', keyFile));
      });
    }

    step('init never overwrites a key file or manifest', () => {
      const before = readFileSync(keyFile);
      const other = join(dir, 'other.keeper-keys.json');
      fails(cli('init', '--account', 'keeper-op.testnet', '--keys', keyFile, '--manifest', join(dir, 'm2.json')),
        /already exists/);
      fails(cli('init', '--account', 'keeper-op.testnet', '--keys', other, '--manifest', manifestFile),
        /already exists/);
      assert.ok(readFileSync(keyFile).equals(before));
      assert.ok(!existsSync(other) && !existsSync(join(dir, 'm2.json')));
      const third = join(dir, 'third' + KEYS_SUFFIX);
      fails(cli('init', '--account', 'keeper-op.testnet', '--keys', third, '--manifest', join(dir, 'missing', 'm.json')),
        /--manifest .* cannot be created \(ENOENT\)\. Nothing was generated/);
      fails(cli('init', '--account', 'keeper-op.testnet', '--keys', join(dir, 'missing', 'k' + KEYS_SUFFIX),
        '--manifest', join(dir, 'm3.json')), /--keys .* cannot be created \(ENOENT\)\. No key file or manifest/);
      assert.ok(!existsSync(third) && !existsSync(join(dir, 'm3.json')), 'a refused init left a file behind');
    });

    step('a bad or existing --out stops before any network or signing', () => {
      const market = 'market.xythum-perps-demo.testnet';
      const existing = join(dir, 'existing.json');
      writeFileSync(existing, 'keep\n');
      const bad = join(dir, 'missing', 'out.json');
      const proving = ['--proving', dir];
      const cases = [
        ['liquidate', '--keys', keyFile, '--market', market, ...proving],
        ['liquidate', '--keys', keyFile, '--market', market, ...proving, '--dry-run'],
        ['check', '--keys', keyFile, '--market', market, ...proving],
        ['ack', '--keys', keyFile, '--market', market],
        ['manifest', '--keys', keyFile],
        ['check-manifest', '--manifest', manifestFile, '--coordinator', 'xythum-perps-demo.testnet'],
      ];
      for (const args of cases) {
        for (const [path, pattern] of [[existing, /already exists/], [bad, /cannot be created \(ENOENT\)/]]) {
          const child = cli(...args, '--out', path);
          fails(child, pattern);
          assert.match(child.stderr, /Nothing was generated, signed or sent/);
          assert.doesNotMatch(child.stderr, /network disabled|Cannot find (?:package|module)/);
          assert.equal(child.stdout, '');
        }
      }
      assert.equal(readFileSync(existing, 'utf8'), 'keep\n');
      assert.ok(!existsSync(join(dir, 'missing')));
      // Control: a fresh --out gets past the reservation to the network stage,
      // which the guard blocks, and the failed command removes its reservation.
      const fresh = join(dir, 'fresh.json');
      const control = cli('liquidate', '--keys', keyFile, '--market', market, ...proving, '--out', fresh);
      assert.equal(control.status, 1, control.stdout);
      assert.doesNotMatch(control.stderr, /--out|UNCERTAIN/);
      assert.equal(control.stdout, '');
      assert.ok(!existsSync(fresh), 'a failed command left its --out reservation');
    });

    step('rejects unsafe paths, non-testnet IDs and unknown flags', () => {
      fails(cli('init', '--account', 'keeper-op.testnet', '--keys', join(dir, 'k.json'), '--manifest', join(dir, 'x')),
        /must end with \.keeper-keys\.json/);
      fails(cli('init', '--account', 'keeper-op.near', '--keys', join(dir, 'n' + KEYS_SUFFIX), '--manifest', join(dir, 'y')),
        /named \.testnet account/);
      fails(cli('init', '--secret', 'x', '--account', 'keeper-op.testnet'), /Unknown option/);
      fails(cli('ack', '--keys', keyFile, '--market', 'market.near'), /named \.testnet account/);
      fails(cli('liquidate', '--keys', keyFile, '--market', 'market.mainnet', '--proving', dir), /named \.testnet account/);
      fails(cli('liquidate', '--keys', keyFile, '--market', 'market.xythum-perps-demo.testnet'), /--proving is required/);
      fails(cli('check-manifest', '--manifest', manifestFile), /--coordinator is required/);
    });

    step('stdout carries the result before a failed --out write', () => {
      const late = join(dir, 'late.json');
      const sink = reserve(late, '--out');
      closeSync(sink.fd); // makes the file write fail with EBADF
      let printed = '';
      const write = process.stdout.write;
      process.stdout.write = (text) => {
        printed += text;
        return true;
      };
      try {
        assert.throws(() => output({ receipt: 1 }, sink, 'RECOVERY-HINT'),
          /stdout is the complete result.*partial file was removed\. RECOVERY-HINT/s);
      } finally {
        process.stdout.write = write;
      }
      assert.deepEqual(JSON.parse(printed), { receipt: 1 });
      assert.ok(!existsSync(late));
    });

    step('manifest holds exactly the public keys of the key file', () => {
      assert.deepEqual(Object.keys(manifest).sort(), MANIFEST_FIELDS);
      const again = ok(cli('manifest', '--keys', keyFile));
      outputs.push(again);
      assert.deepEqual(JSON.parse(again), manifest);
      const ack = createPrivateKey({ key: Buffer.from(keys.signing, 'base64'), type: 'pkcs8', format: 'der' });
      const message = Buffer.from('xythum self-test');
      assert.ok(verify(null, message, ed25519Public(Buffer.from(manifest.ack_key, 'base64')), sign(null, message, ack)));
      const ephemeral = generateKeyPairSync('x25519');
      const recipient = createPublicKey({ key: Buffer.from(manifest.encryption_key, 'base64'), type: 'spki', format: 'der' });
      const local = createPrivateKey({ key: Buffer.from(keys.encryption, 'base64'), type: 'pkcs8', format: 'der' });
      assert.ok(diffieHellman({ privateKey: ephemeral.privateKey, publicKey: recipient })
        .equals(diffieHellman({ privateKey: local, publicKey: ephemeral.publicKey })));
      assert.equal(txPublicKey(keys.txKey), manifest.tx_public_key);
    });

    step('coordinator check-manifest accepts it and rejects tampering', () => {
      const registration = ok(cli('check-manifest', '--manifest', manifestFile, '--coordinator', 'xythum-perps-demo.testnet'));
      outputs.push(registration);
      assert.deepEqual(JSON.parse(registration).keeper, { account_id: manifest.account_id, ack_key: manifest.ack_key });
      const tampered = [
        [{ ...manifest, txKey: keys.txKey }, /exactly the public fields/],
        [{ ...manifest, network: 'mainnet' }, /testnet/],
        [{ ...manifest, account_id: 'keeper-b.xythum-perps-demo.testnet' }, /subaccounts/],
        [{ ...manifest, ack_key: b64(Buffer.alloc(31, 1)) }, /ack_key/],
        [{ ...manifest, ack_key: b64(nearPublicKey(manifest.tx_public_key)) }, /must differ/],
        [{ ...manifest, encryption_key: b64(Buffer.concat([ED25519_SPKI, Buffer.alloc(32, 1)])) }, /X25519/],
      ];
      for (const [index, [value, pattern]] of tampered.entries()) {
        const file = join(dir, 'tampered-' + index + '.json');
        writeFileSync(file, JSON.stringify(value));
        fails(cli('check-manifest', '--manifest', file, '--coordinator', 'xythum-perps-demo.testnet'), pattern);
      }
    });

    step('no private key material reaches stdout or the manifest', () => {
      const secrets = [keys.txKey, keys.txKey.slice(8), keys.encryption, keys.signing];
      for (const field of ['encryption', 'signing']) {
        const seed = Buffer.from(keys[field], 'base64').subarray(-32);
        secrets.push(b64(seed), seed.toString('hex'));
      }
      const txSeed = unbase58(keys.txKey.slice(8)).subarray(0, 32);
      secrets.push(b64(txSeed), txSeed.toString('hex'), base58(txSeed));
      const published = [readFileSync(manifestFile, 'utf8'), ...outputs];
      for (const text of published) for (const secret of secrets) assert.ok(!text.includes(secret));
    });

    step('Git ignores operator key files', () => {
      const git = spawnSync('git', ['check-ignore', '-q', 'operator' + KEYS_SUFFIX], { cwd: repoRoot });
      assert.ok(git.status === 0 || git.status === 128 || git.error, 'add *' + KEYS_SUFFIX + ' to .gitignore');
      if (git.status !== 0) results.push('(not a Git checkout; ignore rule not checked)');
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  output({ self_test: 'passed', network: 'none', checks: results });
}

// --- Entry point ------------------------------------------------------------

const commands = {
  init: [init, { account: {}, keys: {}, manifest: {} }],
  manifest: [exportManifest, { keys: {}, out: {} }],
  'check-manifest': [checkManifest, { manifest: {}, coordinator: {}, out: {} }],
  check: [check, { keys: {}, market: {}, proving: {}, out: {} }],
  ack: [ack, { keys: {}, market: {}, out: {} }],
  liquidate: [liquidate, { keys: {}, market: {}, proving: {}, 'dry-run': { type: 'boolean' }, out: {} }],
  'self-test': [selfTest, {}],
};

if (process.argv[1] && resolve(process.argv[1]) === scriptPath) {
  // Keep stdout for one JSON value; SDK and receipt logs go to stderr.
  globalThis.console = new Console({ stdout: process.stderr, stderr: process.stderr });
  try {
    const entry = commands[process.argv[2]];
    if (!entry) throw new Error('use one of: ' + Object.keys(commands).join(', '));
    const [run, spec] = entry;
    const options = Object.fromEntries(Object.entries(spec).map(([name, option]) => [name, { type: 'string', ...option }]));
    const { values } = parseArgs({ args: process.argv.slice(3), options, strict: true, allowPositionals: false });
    for (const name of ['keys', 'market', 'proving']) {
      if (name in spec && !values[name]) throw new Error('--' + name + ' is required');
    }
    await run(values);
  } catch (error) {
    process.stderr.write(error.message + '\n');
    process.exitCode = 1;
  }
}
