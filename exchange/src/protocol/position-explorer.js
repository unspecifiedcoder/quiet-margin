import { isAccountId } from './api.js';
import { fromBase58, fromBase64, fromUtf8, toBase64 } from './bytes.js';
import { failureReason, interpretOutcome, Rpc, TESTNET_RPC } from './rpc.js';

const ARCHIVAL_TESTNET_RPC = 'https://archival-rpc.testnet.fastnear.com';
const MARKET_CODE = new Set([
  'AhBf8E7k7HPfrf6iSfhtbTAPbsysXh54oguikGzpsfaB',
  '5kXhPSVnxKniqDnKAmuTzpDseN8gxi4Y2JLACPTmK6HD',
]);
const STANDARD = 'xythum_near_perps';

function account(id) {
  if (!isAccountId(id)) throw new Error('Enter a valid NEAR testnet account ID.');
  return id;
}

function hash(value) {
  if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(value) || fromBase58(value).length !== 32) {
    throw new Error('Enter a valid NEAR transaction hash.');
  }
  return value;
}

function commitment(value) {
  if (toBase64(fromBase64(value, 32)) !== value) throw new Error('Invalid position commitment on chain.');
  return value;
}

function decode(args) {
  return JSON.parse(fromUtf8(fromBase64(args)));
}

async function marketAt(rpc, id, blockId) {
  const state = await rpc.call('query', {
    request_type: 'view_account', account_id: id,
    ...(blockId ? { block_id: blockId } : { finality: 'final' }),
  });
  if (!MARKET_CODE.has(state?.code_hash)) throw new Error('This account does not run a recognized Quiet Margin market.');
  if (blockId && state.block_hash !== blockId) throw new Error('NEAR returned a different historical block.');
  return state;
}

async function viewAt(rpc, id, blockId, method) {
  const result = await rpc.call('query', {
    request_type: 'call_function', account_id: id, block_id: blockId, method_name: method, args_base64: 'e30=',
  });
  if (result?.block_hash !== blockId || !Array.isArray(result.result)) {
    throw new Error('NEAR could not read ' + method + ' at the requested block.');
  }
  return JSON.parse(fromUtf8(Uint8Array.from(result.result)));
}

async function snapshot(rpc, id, blockId) {
  const state = await marketAt(rpc, id, blockId);
  const [slot, ledger, oracle, config] = await Promise.all(
    ['get_active', 'get_ledger', 'get_oracle', 'get_config'].map(
      (method) => viewAt(rpc, id, state.block_hash, method),
    ),
  );
  return {
    market: id, block: state.block_height, blockHash: state.block_hash,
    trader: config.trader_id, mark: oracle?.price_ticks ?? null, round: oracle?.round ?? null,
    position: slot ? {
      nonce: slot.nonce, commitment: commitment(slot.commitment), openMark: slot.open_price_ticks,
      escrow: ledger.trader_locked, envelopes: slot.ciphertexts.length,
    } : null,
  };
}

async function transaction(rpc, txHash, signer) {
  const outcome = await rpc.txFinal(hash(txHash), account(signer));
  const tx = outcome?.transaction;
  if (outcome?.final_execution_status !== 'FINAL' || tx?.hash !== txHash || tx.signer_id !== signer) {
    throw new Error('NEAR did not return a final transaction for that hash and signer.');
  }
  return { outcome, tx };
}

function positionEvent(outcome, market, name, nonce) {
  for (const receipt of outcome.receipts_outcome ?? []) {
    if (receipt.outcome.executor_id !== market) continue;
    for (const log of receipt.outcome.logs) {
      if (!log.startsWith('EVENT_JSON:')) continue;
      let event;
      try { event = JSON.parse(log.slice('EVENT_JSON:'.length)); } catch { continue; }
      if (event?.standard !== STANDARD || event.event !== name || !Array.isArray(event.data)) continue;
      const data = event.data.find((entry) => entry?.nonce === nonce);
      if (data) return { data, blockHash: receipt.block_hash };
    }
  }
  return null;
}

function call(tx, allowed) {
  const action = tx.actions?.length === 1 && tx.actions[0].FunctionCall;
  if (!allowed.includes(action?.method_name)) {
    throw new Error('That transaction does not call ' + allowed.join(' or ') + '.');
  }
  return { method: action.method_name, args: decode(action.args) };
}

async function settlement(rpc, evidence, position, market) {
  const { tx, outcome } = await transaction(rpc, evidence.hash, evidence.signer);
  if (tx.receiver_id !== market) throw new Error('This settlement is for a different market.');
  const { method, args } = call(tx, ['close', 'liquidate']);
  if (args.nonce !== position.nonce || args.root !== position.commitment) {
    throw new Error('This settlement is for a different position.');
  }
  const execution = interpretOutcome(outcome);
  if (!execution.ok) {
    if (method === 'liquidate' && failureReason(execution.failures) === 'ERR_PROOF_INVALID') {
      return { ...evidence, status: 'Liquidation rejected', reason: 'ERR_PROOF_INVALID', round: args.round };
    }
    throw new Error('This transaction did not successfully settle the position.');
  }
  const event = positionEvent(outcome, market, method === 'close' ? 'position_closed' : 'position_liquidated', args.nonce);
  if (!event || event.data.round !== args.round || event.data.refund !== args.refund || event.data.bad_debt !== args.bad_debt) {
    throw new Error('The settlement event does not match the submitted position.');
  }
  return {
    ...evidence, status: method === 'close' ? 'Closed' : 'Liquidated', round: args.round,
    refund: args.refund, badDebt: args.bad_debt, blockHash: event.blockHash,
  };
}

export async function inspectPosition({ market, open, settlement: evidence }, {
  current = new Rpc(TESTNET_RPC, { timeoutMs: 8_000 }),
  archive = new Rpc(ARCHIVAL_TESTNET_RPC, { timeoutMs: 8_000 }),
} = {}) {
  if (!open) return snapshot(current, account(market));
  const rpc = {
    async call(method, params) {
      try {
        const result = await current.call(method, params);
        if (method !== 'query' || !result?.error) return result;
      } catch {
        // Recent blocks usually resolve here. Use archival RPC when pruned.
      }
      return archive.call(method, params);
    },
    txFinal(txHash, signer) {
      return this.call('tx', { tx_hash: txHash, sender_account_id: signer, wait_until: 'FINAL' });
    },
  };
  const { tx, outcome } = await transaction(rpc, open.hash, open.signer);
  const { args } = call(tx, ['open']);
  if (!interpretOutcome(outcome).ok) throw new Error('The open transaction was rejected by NEAR.');
  const event = positionEvent(outcome, tx.receiver_id, 'position_opened', args.nonce);
  if (!event) throw new Error('NEAR returned no Quiet Margin open event for that transaction.');
  const result = await snapshot(rpc, tx.receiver_id, event.blockHash);
  if (result.trader !== open.signer || result.position?.nonce !== args.nonce
    || result.position?.commitment !== commitment(args.commitment)) {
    throw new Error('The open receipt does not match the position at its execution block.');
  }
  return {
    ...result, open,
    settlement: evidence ? await settlement(rpc, evidence, result.position, result.market) : null,
  };
}
