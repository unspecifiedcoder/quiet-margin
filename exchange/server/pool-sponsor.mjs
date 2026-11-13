import assert from 'node:assert/strict';
import { KeyPair } from 'near-workspaces';
import { connectChain, TESTNET_RPC } from '../../scripts/testnet-client.mjs';
import { Rpc, interpretOutcome } from '../src/protocol/rpc.js';
import { signTransaction, functionCall } from '../src/protocol/tx.js';
import { actionCreators } from '@near-js/transactions';

export async function connectPoolSponsor(accountId, secret) {
  assert.match(accountId, /^[a-z0-9_-]+(?:\.[a-z0-9_-]+)*\.testnet$/);
  const key = KeyPair.fromString(secret);
  const signer = { publicKey: key.getPublicKey().toString(), sign: (digest) => key.sign(digest).signature };
  const network = await connectChain(TESTNET_RPC, true);
  const rpc = new Rpc(TESTNET_RPC);
  const sponsor = { accountId };
  const complete = async (pending) => {
    try {
      const status = await rpc.txStatus(pending.hash, accountId);
      return status.final_execution_status === 'FINAL' ? status : rpc.txFinal(pending.hash, accountId);
    } catch (error) {
      if (error.kind !== 'UNKNOWN_TRANSACTION') throw error;
    }
    await rpc.sendTx(pending.signedTx, { waitUntil: 'EXECUTED_OPTIMISTIC' });
    return rpc.txFinal(pending.hash, accountId);
  };
  async function send(target, actions, claim, stage, store) {
    let pending = claim?.pending?.[stage];
    if (!pending) {
      const [access, block] = await Promise.all([rpc.viewAccessKey(accountId, signer.publicKey), rpc.finalBlock()]);
      assert.equal(access.permission, 'FullAccess');
      pending = await signTransaction({ signer, signerId: accountId, receiverId: target, actions,
        nonce: BigInt(access.nonce) + 1n, blockHash: block.header.hash });
      if (claim) {
        claim.pending ??= {};
        claim.pending[stage] = pending;
        await store.save(claim);
      }
    }
    const result = await complete(pending);
    assert.equal(result.final_execution_status, 'FINAL');
    assert(interpretOutcome(result).ok, 'Test funding transaction failed');
    if (claim) {
      claim[stage] = pending.hash;
      delete claim.pending[stage];
      await store.save(claim);
    }
    return pending.hash;
  }
  const chain = {
    provider: network.provider,
    callOnce(_sponsor, target, method, args, gas, deposit, claim, stage, store) {
      return send(target, [functionCall(method, args, { gas, deposit })], claim, stage, store);
    },
    transferOnce(_sponsor, target, amount, claim, stage, store) {
      return send(target, [actionCreators.transfer(amount)], claim, stage, store);
    },
  };
  return { sponsor, chain };
}
