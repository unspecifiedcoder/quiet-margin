import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { test } from 'node:test';
import { Api, ApiError, captureInvite, INVITE_HEADER, INVITE_STORAGE_KEY } from '../api.js';
import { toBase64 } from '../bytes.js';

const INVITE = randomBytes(32).toString('hex');
// A canonical ed25519 public key and a 64-byte proof (shape checks only).
const PUBLIC_KEY = 'ed25519:' + '1'.repeat(32);
const PROOF = toBase64(new Uint8Array(64));

function memoryStorage(initial = {}) {
  const map = new Map(Object.entries(initial));
  return {
    map,
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => map.set(key, String(value)),
    removeItem: (key) => map.delete(key),
  };
}

function browser(hash, { pathname = '/trade', search = '?x=1' } = {}) {
  const location = { hash, pathname, search };
  const replaced = [];
  const history = {
    state: { kept: true },
    replaceState(state, _title, url) {
      replaced.push({ state, url });
      const [rest, fragment] = url.split('#');
      location.hash = fragment === undefined ? '' : '#' + fragment;
      location.search = rest.includes('?') ? rest.slice(rest.indexOf('?')) : '';
    },
  };
  return { location, history, replaced };
}

test('the invite fragment is moved out of the URL into sessionStorage', () => {
  const { location, history, replaced } = browser('#invite=' + INVITE);
  const storage = memoryStorage();
  assert.equal(captureInvite({ location, history, storage }), INVITE);
  assert.deepEqual(replaced, [{ state: { kept: true }, url: '/trade?x=1' }]);
  assert.equal(location.hash, '');
  assert.equal(storage.map.get(INVITE_STORAGE_KEY), INVITE);
  // A later capture (reload, retry, new Api) still finds it.
  assert.equal(captureInvite({ location, history, storage }), INVITE);
  assert.equal(replaced.length, 1);

  // Other fragment parameters survive untouched.
  const other = browser('#tab=book&invite=' + INVITE + '&z');
  captureInvite({ ...other, storage: memoryStorage() });
  assert.equal(other.replaced[0].url, '/trade?x=1#tab=book&z');
});

test('a malformed invite is removed from the URL but never stored', () => {
  for (const bad of [INVITE.toUpperCase(), INVITE.slice(1), INVITE + '0', '', 'g'.repeat(64)]) {
    const { location, history, replaced } = browser('#invite=' + bad);
    const storage = memoryStorage();
    captureInvite({ location, history, storage });
    assert.equal(replaced.length, 1, bad);
    assert.equal(location.hash, '');
    assert.equal(storage.map.has(INVITE_STORAGE_KEY), false, bad);
  }
  // A duplicated parameter is ambiguous and also discarded.
  const twice = browser('#invite=' + INVITE + '&invite=' + INVITE);
  const storage = memoryStorage();
  captureInvite({ ...twice, storage });
  assert.equal(storage.map.has(INVITE_STORAGE_KEY), false);
  assert.equal(twice.location.hash, '');
  // A tampered stored value is ignored.
  assert.notEqual(captureInvite({ ...browser(''), storage: memoryStorage({ [INVITE_STORAGE_KEY]: 'x' }) }), 'x');
});

test('the newest invite link wins: a bad or duplicated one clears the stored invite', async () => {
  const older = randomBytes(32).toString('hex');
  // A new valid link replaces an older stored invite.
  const storage = memoryStorage({ [INVITE_STORAGE_KEY]: older });
  assert.equal(captureInvite({ ...browser('#invite=' + INVITE), storage }), INVITE);
  assert.equal(storage.map.get(INVITE_STORAGE_KEY), INVITE);
  for (const hash of ['#invite=' + INVITE.slice(2), '#invite=' + older + '&invite=' + older, '#invite=']) {
    const kept = memoryStorage({ [INVITE_STORAGE_KEY]: older });
    const link = browser(hash);
    assert.equal(captureInvite({ ...link, storage: kept }), null, hash);
    assert.equal(kept.map.has(INVITE_STORAGE_KEY), false, hash);
    assert.equal(link.location.hash, '');
    // A reload (no fragment) also finds nothing: no silent fallback.
    assert.equal(captureInvite({ ...browser(''), storage: kept }), null, hash);
  }
  // Storage that cannot remove still fails closed for this capture.
  const stuck = { getItem: () => older, setItem() {}, removeItem() { throw new Error('denied'); } };
  assert.equal(captureInvite({ ...browser('#invite=bad'), storage: stuck }), null);

  // Session bearer auth is independent of the invite: an enrolled client keeps
  // working, and an enrollment retry without an invite sends no header.
  const seen = [];
  const api = new Api({
    invite: null,
    fetchImpl: async (url, init) => {
      seen.push({ url, headers: init.headers });
      return new Response(JSON.stringify({ error: 'invite_required' }), { status: 401 });
    },
  });
  api.sessionId = 's'.repeat(43);
  await assert.rejects(api.refreshOracle(), ApiError);
  await assert.rejects(api.createSession(PUBLIC_KEY, PROOF), (error) => error.status === 401);
  assert.equal(seen[0].headers.authorization, 'Bearer ' + 's'.repeat(43));
  assert.equal(seen[1].headers[INVITE_HEADER], undefined);
});

test('without an invite nothing changes (local mode)', async () => {
  const { location, history, replaced } = browser('#book');
  const storage = memoryStorage();
  captureInvite({ location, history, storage });
  assert.equal(replaced.length, 0);
  assert.equal(location.hash, '#book');
  assert.equal(storage.map.size, 0);

  const seen = [];
  const api = new Api({
    invite: null,
    fetchImpl: async (url, init) => {
      seen.push(init.headers);
      return new Response(JSON.stringify({ error: 'quota_unset' }), { status: 503 });
    },
  });
  await assert.rejects(api.createSession(PUBLIC_KEY, PROOF), ApiError);
  assert.equal(seen[0][INVITE_HEADER], undefined);
});

test('the invite is sent only on enrollment and is never exposed by the client', async () => {
  const seen = [];
  const api = new Api({
    invite: INVITE,
    fetchImpl: async (url, init) => {
      seen.push({ url, headers: init.headers });
      return new Response(JSON.stringify({ error: 'invite_required', message: 'a valid invite is required' }),
        { status: 401 });
    },
  });
  await assert.rejects(api.createSession(PUBLIC_KEY, PROOF), (error) => {
    assert.equal(error.status, 401);
    assert.ok(!error.message.includes(INVITE));
    return true;
  });
  // Retrying sends it again.
  await assert.rejects(api.createSession(PUBLIC_KEY, PROOF), ApiError);
  await assert.rejects(api.getSession('s'.repeat(43)), ApiError);
  await assert.rejects(api.refreshOracle(), ApiError);
  assert.deepEqual(seen.map(({ url }) => url), ['/api/sessions', '/api/sessions', '/api/session', '/api/session/refresh']);
  assert.equal(seen[0].headers[INVITE_HEADER], INVITE);
  assert.equal(seen[1].headers[INVITE_HEADER], INVITE);
  assert.equal(seen[0].headers.authorization, undefined);
  for (const { headers } of seen.slice(2)) assert.equal(headers[INVITE_HEADER], undefined);
  assert.ok(!JSON.stringify(api).includes(INVITE));
  assert.ok(!Object.values(api).includes(INVITE));
  // A malformed invite option is dropped rather than sent.
  const bad = new Api({ invite: 'nope', fetchImpl: async (url, init) => {
    assert.equal(init.headers[INVITE_HEADER], undefined);
    return new Response('{}', { status: 401 });
  } });
  await assert.rejects(bad.createSession(PUBLIC_KEY, PROOF), ApiError);
});
