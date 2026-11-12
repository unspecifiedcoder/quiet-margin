// SHA-256 pins of the complete public proving keys, exactly as served
// (uncompressed) by `/api/proving/{open,close}.pk`, from the audited release
// configuration. A deployment may override them with the public build-time
// values VITE_XYTHUM_OPEN_PK_SHA256 / VITE_XYTHUM_CLOSE_PK_SHA256 (lowercase
// hex). A malformed override fails closed instead of falling back.

const DEFAULTS = {
  open: '7493ceba35d7d37768794b4b1796aded44cae4483da8c9b45bd9a636b784010f',
  close: '26df7dc7c8f3af3e4d1dc2c6c8c307f838512069a48837148f97cda8c082a58a',
};

const HEX32 = /^[0-9a-f]{64}$/;

export function resolvePins(env = {}) {
  const pick = (kind, name) => {
    const value = env[name];
    const pin = value === undefined || value === '' ? DEFAULTS[kind] : value;
    if (!HEX32.test(pin)) throw new Error(name + ' must be 64 lowercase hex digits');
    return pin;
  };
  return Object.freeze({
    open: pick('open', 'VITE_XYTHUM_OPEN_PK_SHA256'),
    close: pick('close', 'VITE_XYTHUM_CLOSE_PK_SHA256'),
  });
}

export const DEFAULT_PK_SHA256 = Object.freeze({ ...DEFAULTS });
