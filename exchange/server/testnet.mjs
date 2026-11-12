// Real NEAR testnet adapter built on the pinned demo client. Only the root,
// maker and oracle role signers are loaded; the existing MARKET role key is
// used solely to deploy and lock a fresh session market account.
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { utils } from 'near-api-js';
import {
  connectChain, demoAccounts, loadDemoEnv, TESTNET_GAS, TESTNET_RPC, viewFinal, waitFinal,
} from '../../scripts/testnet-client.mjs';
import { FULL_GAS } from '../../tests/actor.mjs';
import { safeMessage } from './util.mjs';

const KEEPER_ROLES = ['KEEPER_A', 'KEEPER_B'];
const SIGNERS = ['DEMO', 'MAKER', 'ORACLE'];

// The SDK prints receipt IDs and contract logs to stdout. The coordinator logs
// only its own sanitized lines, so silence both module builds of the SDK.
const QUIET = { log() {}, warn() {}, error() {}, debug() {}, verbose() {}, fatal() {} };
utils.Logger.overrideLogger(QUIET);
createRequire(import.meta.url)('near-api-js').utils.Logger.overrideLogger(QUIET);

export const codeHashOf = (wasm) => utils.serialize.base_encode(createHash('sha256').update(wasm).digest());

export async function connectTestnet() {
  const { env, roles } = loadDemoEnv();
  const chain = await connectChain(TESTNET_RPC, true);
  const accounts = await demoAccounts(chain, Object.fromEntries(SIGNERS.map((role) => [role, roles[role]])));
  return createTestnetAdapter({ env, roles, chain, accounts });
}

// Separated from connectTestnet so its guards can be tested with a fake SDK chain.
export async function createTestnetAdapter({ env, roles, chain, accounts, finalize = waitFinal }) {
  const roleIds = new Set(Object.values(roles).map(({ id }) => id));
  const existingMarket = roles.MARKET.id;
  const marketKey = roles.MARKET.key;

  const finished = async (tx, what) => {
    if (!tx.succeeded || tx.receiptFailures.length !== 0) {
      throw new Error(what + ' failed: ' + safeMessage(JSON.stringify(tx.failures), 200));
    }
    try {
      await finalize(chain, tx);
    } catch (error) {
      throw new Error(what + ' not final (check ' + tx.transactionReceipt.hash + '): ' + safeMessage(error, 120));
    }
    return { hash: tx.transactionReceipt.hash };
  };
  const refuseRoleAccount = (id) => {
    if (roleIds.has(id)) throw new Error('refusing to modify existing demo role account ' + id);
  };

  const adapter = {
    view: (accountId, method, args = {}) => viewFinal(chain, accountId, method, args),

    async accountState(accountId) {
      try {
        const state = await chain.provider.query({ request_type: 'view_account', finality: 'final', account_id: accountId });
        return { amount: state.amount, locked: state.locked, code_hash: state.code_hash, storage_usage: state.storage_usage };
      } catch (error) {
        if (/does not exist|UNKNOWN_ACCOUNT/i.test(String(error?.message ?? error) + String(error?.type ?? ''))) return null;
        throw error;
      }
    },

    async accessKeys(accountId) {
      const list = await chain.provider.query({
        request_type: 'view_access_key_list', finality: 'final', account_id: accountId,
      });
      return list.keys.map(({ public_key, access_key }) => ({
        public_key, permission: access_key.permission === 'FullAccess' ? 'FullAccess' : 'FunctionCall',
      }));
    },

    async finalHeight() {
      return (await chain.provider.block({ finality: 'final' })).header.height;
    },

    async call(signer, contractId, method, args, options = {}) {
      if (!SIGNERS.includes(signer)) throw new Error('unknown signer role ' + signer);
      if (contractId === existingMarket) throw new Error('refusing to call the existing demo market');
      const tx = await accounts[signer].callRaw(contractId, method, args, { gas: TESTNET_GAS, ...options });
      return finished(tx, method);
    },

    async createMarketAccount(accountId, amount) {
      refuseRoleAccount(accountId);
      const tx = await accounts.DEMO.batch(accountId)
        .createAccount().transfer(amount).addKey(marketKey.getPublicKey()).transact();
      return finished(tx, 'market account creation');
    },

    async createTraderAccount(accountId, amount, publicKey) {
      refuseRoleAccount(accountId);
      const tx = await accounts.DEMO.batch(accountId)
        .createAccount().transfer(amount).addKey(publicKey).transact();
      return finished(tx, 'trader account creation');
    },

    // Deploy, initialize and delete the deploy key in one atomic receipt, so
    // the session market is immutable once it exists with code.
    async deployMarket(accountId, wasm, initArgs) {
      refuseRoleAccount(accountId);
      const market = chain.rootAccount.getAccount(accountId);
      await market.setKey(marketKey);
      const tx = await market.batch(market)
        .deployContract(wasm)
        .functionCall('init', initArgs, { gas: FULL_GAS })
        .deleteKey(marketKey.getPublicKey())
        .transact();
      return finished(tx, 'market deployment');
    },
  };

  const metadata = await adapter.view(roles.TOKEN.id, 'ft_metadata');
  if (metadata.symbol !== 'mUSDC' || metadata.decimals !== 2) throw new Error('unexpected demo token');

  return {
    chain: adapter,
    rpcUrl: TESTNET_RPC,
    ids: {
      root: roles.DEMO.id, token: roles.TOKEN.id, maker: roles.MAKER.id, oracle: roles.ORACLE.id,
      keepers: KEEPER_ROLES.map((role) => roles[role].id),
      forbidden: [...roleIds],
      rolePublicKeys: Object.values(roles).map(({ key }) => key.getPublicKey().toString()),
    },
    marketDeployKey: marketKey.getPublicKey().toString(),
    keeperAckKeys: KEEPER_ROLES.map((role) => env['NEAR_' + role + '_ACK_PUBLIC']),
    keeperEncryptionKeys: KEEPER_ROLES.map((role) => env['NEAR_' + role + '_ENCRYPTION_PUBLIC']),
    keeperSecrets(index, { withTxKey }) {
      const role = KEEPER_ROLES[index];
      if (!role) throw new Error('unknown keeper');
      if (withTxKey) {
        // Only cold Keeper B submits transactions from this coordinator.
        if (index !== 1) throw new Error('only Keeper B submits liquidations');
        return { encryption: env['NEAR_' + role + '_ENCRYPTION_SECRET'], txKey: roles[role].key.toString() };
      }
      return { encryption: env['NEAR_' + role + '_ENCRYPTION_SECRET'], signing: env['NEAR_' + role + '_ACK_SECRET'] };
    },
  };
}
