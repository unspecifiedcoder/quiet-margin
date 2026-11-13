import { concat, equalBytes, fromBase64, le16, le32, sha256, toBase64, utf8 } from './bytes.js';
import { decryptEnvelope, encryptEnvelope } from './envelope.js';

const info = utf8('quiet-margin:pool-keeper:v1');
const field = (value) => {
  const bytes = fromBase64(value, 32);
  if (toBase64(bytes) !== value) throw new Error('Noncanonical field encoding.');
  return bytes;
};

export async function sealPoolOpening(opening, key) {
  const plain = concat(Uint8Array.from(opening.blinder), le16(opening.lots), le16(opening.entry),
    le32(opening.margin), Uint8Array.of(Number(opening.short)));
  return encryptEnvelope(plain, key, opening.commitment, info);
}

export async function openPoolEnvelope(envelope, secret, commitment) {
  const plain = await decryptEnvelope(envelope, secret, commitment, info, 113);
  const view = new DataView(plain.buffer, plain.byteOffset, plain.byteLength);
  if (plain[40] > 1) throw new Error('Invalid position direction.');
  return { blinder: [...plain.slice(0, 32)], lots: view.getUint16(32, true),
    entry: view.getUint16(34, true), margin: view.getUint32(36, true), short: plain[40] === 1 };
}

export async function poolAckMessage(domain, index, { commitment, context, owner_tag, envelope }) {
  if (index !== 0 && index !== 1) throw new Error('Invalid keeper index.');
  return sha256(utf8('QM:keeper-ack:1:'), field(domain), Uint8Array.of(index),
    field(commitment), field(context), field(owner_tag), await sha256(fromBase64(envelope, 113)));
}

export function validateOpening(hashes, payload, opening) {
  const { lots, entry, margin, short, blinder } = opening;
  if (lots < 1 || lots > 50 || entry < 1 || entry > 20_000 || margin < 1 || margin > 60_000
    || lots * entry > 3 * margin || !equalBytes(field(payload.commitment),
      hashes.commitment(field(payload.context), blinder, lots, entry, margin, short))) {
    throw new Error('Keeper envelope does not match the committed position.');
  }
}

export function belowMaintenance(opening, mark) {
  const pnl = (mark - opening.entry) * opening.lots * (opening.short ? -1 : 1);
  return 20 * (opening.margin + pnl) <= mark * opening.lots;
}
