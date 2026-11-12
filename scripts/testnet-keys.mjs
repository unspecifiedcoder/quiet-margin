import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import near from 'near-api-js';

const envPath = fileURLToPath(new URL('../.env', import.meta.url));
const demo = process.argv[2] ?? 'xythum-perps-demo.testnet';
if (!/^[a-z0-9]+(?:-[a-z0-9]+)*\.testnet$/.test(demo) || demo.length > 50) {
  throw new Error('Provide a named testnet account with space for a subaccount prefix');
}

const ids = {
  DEMO: demo,
  MARKET: 'market.' + demo,
  TOKEN: 'musdc.' + demo,
  TRADER: 'trader.' + demo,
  MAKER: 'maker.' + demo,
  ORACLE: 'oracle.' + demo,
  KEEPER_A: 'keeper-a.' + demo,
  KEEPER_B: 'keeper-b.' + demo,
};
const lines = [
  '# NEAR testnet demo credentials. Keep this local file private.',
  'NEAR_NETWORK_ID=testnet',
  'NEAR_RPC_URL=https://test.rpc.fastnear.com',
  'NEAR_DEPLOYMENT_ID=' + randomBytes(32).toString('base64'),
];

for (const [role, id] of Object.entries(ids)) {
  const key = near.KeyPair.fromRandom('ed25519');
  lines.push('NEAR_' + role + '_ACCOUNT_ID=' + id);
  lines.push('NEAR_' + role + '_PUBLIC_KEY=' + key.getPublicKey().toString());
  lines.push('NEAR_' + role + '_SECRET_KEY=' + key.toString());
  if (role.startsWith('KEEPER_')) {
    const encryption = generateKeyPairSync('x25519');
    const ack = generateKeyPairSync('ed25519');
    lines.push('NEAR_' + role + '_ENCRYPTION_SECRET='
      + encryption.privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64'));
    lines.push('NEAR_' + role + '_ENCRYPTION_PUBLIC='
      + encryption.publicKey.export({ format: 'der', type: 'spki' }).toString('base64'));
    lines.push('NEAR_' + role + '_ACK_SECRET='
      + ack.privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64'));
    lines.push('NEAR_' + role + '_ACK_PUBLIC='
      + ack.publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('base64'));
  }
}

writeFileSync(envPath, lines.join('\n') + '\n', { flag: 'wx', mode: 0o600 });
console.log('Saved local testnet credentials in .env for ' + demo);
