// Loads the Node reference implementations straight out of tests/actor.mjs
// (without its chain dependencies), so the browser protocol is tested
// against the exact code the keepers and the testnet demo run, not a copy.
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('../../../../tests/actor.mjs', import.meta.url), 'utf8');

function topLevelChunks(text) {
  const chunks = [];
  let current = null;
  for (const line of text.split('\n')) {
    if (/^[A-Za-z]/.test(line)) {
      if (current) chunks.push(current);
      current = [line];
    } else if (current) {
      current.push(line);
    }
  }
  if (current) chunks.push(current);
  return chunks.map((c) => c.join('\n'));
}

const NAMES = ['SHA', 'le32', 'bytes', 'base64', 'label', 'publicDer', 'privateDer', 'publicKey', 'privateKey',
  'aeadKey', 'encodeWitness', 'decodeWitness', 'encrypt', 'decrypt', 'positionContext', 'quoteDigest',
  'configureKeeper'];

const picked = topLevelChunks(source).filter((chunk) => NAMES.some((name) =>
  new RegExp(`^(export )?(async )?(function ${name}\\(|const ${name} =)`).test(chunk)));
if (picked.length !== NAMES.length) throw new Error('tests/actor.mjs layout changed; update actor-reference.mjs');

const prelude = `
import assert from 'node:assert/strict';
import { createCipheriv, createDecipheriv, createHash, createPrivateKey, createPublicKey,
  diffieHellman, generateKeyPairSync, hkdfSync, randomBytes, sign } from 'node:crypto';
import { writeFileSync } from 'node:fs';
`;
const body = picked.map((c) => c.replace(/^export /, '')).join('\n');
const mod = await import('data:text/javascript;base64,' + Buffer.from(prelude + body
  + '\nexport { encrypt, decrypt, encodeWitness, decodeWitness, positionContext, quoteDigest, configureKeeper };\n')
  .toString('base64'));

export const { encrypt, decrypt, encodeWitness, decodeWitness, positionContext, quoteDigest, configureKeeper } = mod;
