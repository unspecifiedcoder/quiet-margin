// User-signed transaction submission with a durable journal.
//
// Before broadcast the signed bytes and hash are journaled locally. A lost
// response or a page reload therefore never forgets a transaction that may
// have landed: on retry the same bytes are re-sent (same hash, so NEAR
// executes it at most once) and followed to FINAL. Only a definitive
// rejection (invalid, expired, or nonce consumed without this hash) clears
// the journal without an outcome; otherwise the result stays ambiguous and
// is reported as such.

import { failureReason, interpretOutcome, RpcError } from './rpc.js';
import { signTransaction } from './tx.js';

const JOURNAL = 'journal';
const FINAL_WAIT_MS = 180_000;

export class AmbiguousTxError extends Error {
  constructor(entry, cause) {
    super(`${entry.label} transaction ${entry.hash} was submitted but its finality is not confirmed yet; `
      + 'it is kept locally and will be checked again before any new action');
    this.name = 'AmbiguousTxError';
    this.hash = entry.hash;
    this.label = entry.label;
    if (cause) this.cause = cause;
  }
}

export class TxFailedError extends Error {
  constructor(label, hash, reason) {
    super(`${label} failed on chain${hash ? ' in ' + hash : ''}: ${reason}`);
    this.name = 'TxFailedError';
    this.hash = hash;
    this.reason = reason;
  }
}

const definitive = (error) => error instanceof RpcError
  && /INVALID_TRANSACTION|InvalidTxError|Expired|InvalidNonce|NotEnoughBalance|InvalidSignature|AccessKeyNotFound|DoesNotExist/i
    .test(error.kind + ' ' + error.message);

export class Chain {
  constructor({ rpc, store, signer, accountId, onReceipt, sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
    now = () => Date.now(), finalWaitMs = FINAL_WAIT_MS }) {
    Object.assign(this, { rpc, store, signer, accountId, onReceipt, sleep, now, finalWaitMs });
  }

  journal() {
    return this.store.get(JOURNAL);
  }

  /**
   * Resolves a journaled transaction left by an earlier attempt. Returns
   * the interpreted outcome, `null` if it definitively never executed, or
   * throws `AmbiguousTxError`.
   */
  async resolveJournal() {
    const entry = await this.journal();
    if (!entry) return null;
    return this.finalize(entry);
  }

  /** Signs, journals, broadcasts and follows one transaction to FINAL. */
  async submit(label, receiverId, actions) {
    // Callers resolve the journal and re-read chain state before deciding.
    if (await this.journal()) throw new Error('an earlier transaction is still unresolved');
    const [key, block] = await Promise.all([
      this.rpc.viewAccessKey(this.accountId, this.signer.publicKey),
      this.rpc.finalBlock(),
    ]);
    if (key.permission !== 'FullAccess') {
      throw new Error('the browser key is not a full-access key of ' + this.accountId);
    }
    const lastUsed = (await this.store.get('nonce')) ?? 0;
    const nonce = Math.max(Number(key.nonce), lastUsed) + 1;
    const { hash, signedTx } = await signTransaction({
      signer: this.signer, signerId: this.accountId, receiverId, nonce,
      blockHash: block.header.hash, actions,
    });
    const entry = { label, hash, signedTx, receiverId, senderId: this.accountId, nonce, createdAt: this.now() };
    await this.store.put(JOURNAL, entry);
    await this.store.put('nonce', nonce);
    this.onReceipt?.({ label, hash, status: 'pending' });
    try {
      await this.rpc.sendTx(signedTx);
    } catch (error) {
      if (definitive(error)) {
        await this.store.delete(JOURNAL);
        this.onReceipt?.({ label, hash, status: 'rejected' });
        throw new TxFailedError(label, null, 'rejected by RPC before execution: ' + error.message);
      }
      // Network loss or timeout: the transaction may still land. Follow it.
    }
    const result = await this.finalize(entry);
    if (!result) throw new TxFailedError(label, null, 'expired without executing');
    return result;
  }

  async finalize(entry) {
    const deadline = this.now() + this.finalWaitMs;
    let lastError;
    let unknown = 0;
    while (this.now() < deadline) {
      try {
        const outcome = await this.rpc.txFinal(entry.hash, entry.senderId);
        if (outcome.final_execution_status && outcome.final_execution_status !== 'FINAL') {
          lastError = new Error('not final yet');
        } else {
          const result = { ...interpretOutcome(outcome), hash: entry.hash, label: entry.label, outcome };
          await this.store.delete(JOURNAL);
          this.onReceipt?.({
            label: entry.label, hash: entry.hash, status: result.ok ? 'final' : 'failed',
            reason: result.ok ? undefined : failureReason(result.failures),
          });
          return result;
        }
      } catch (error) {
        lastError = error;
        if (error instanceof RpcError && error.kind === 'UNKNOWN_TRANSACTION') {
          unknown += 1;
          try {
            await this.rpc.sendTx(entry.signedTx);
          } catch (sendError) {
            if (definitive(sendError) && unknown >= 3) {
              // The nonce was consumed or the block hash expired, and the
              // network still does not know this hash: it never executed.
              await this.store.delete(JOURNAL);
              this.onReceipt?.({ label: entry.label, hash: entry.hash, status: 'rejected' });
              return null;
            }
          }
        } else if (!(error instanceof RpcError)) {
          throw error;
        }
      }
      await this.sleep(2_000);
    }
    throw new AmbiguousTxError(entry, lastError);
  }

  /** Submits and requires success; returns the result. */
  async call(label, receiverId, actions) {
    const result = await this.submit(label, receiverId, actions);
    if (!result.ok) throw new TxFailedError(label, result.hash, failureReason(result.failures));
    return result;
  }
}
