// Backup crypto: the key, the recovery code the user writes down, and the
// optional passphrase escrow.
//
// The key model was decided with the user: a device-generated 32-byte key,
// shown once as a recovery code. The server never sees it. A "token generated
// after login" was rejected precisely because it would let the server decrypt,
// which would make the backup a copy of the data the privacy invariant says the
// server must not hold.
//
// Two paths, and only one of them needs a KDF:
//
//   recovery-code-v1                  the recovery code IS the key. No KDF, no
//                                     server involvement, nothing to measure.
//   recovery-code-v1+passphrase-escrow the same key, additionally wrapped under
//                                     a passphrase-derived KEK and handed to the
//                                     server as an opaque blob it cannot open.
//
// Primitives are reused from what `lib/e2ee/e2ee-service.ts` already ships —
// same libraries, same `.js` subpath import style — rather than introducing a
// second crypto stack alongside it.

import { xchacha20poly1305 } from '@noble/ciphers/chacha.js';
import { randomBytes } from '@noble/ciphers/utils.js';
import { pbkdf2Async } from '@noble/hashes/pbkdf2.js';
import { scryptAsync } from '@noble/hashes/scrypt.js';
import { sha256 } from '@noble/hashes/sha2.js';

import type { KdfParams } from './types';

export const BACKUP_KEY_BYTES = 32;
const NONCE_BYTES = 24; // XChaCha20

/**
 * Crockford Base32. `I`, `L`, `O` and `U` are absent by design: the first three
 * are the characters people transcribe wrongly, and `U` is excluded so a code
 * cannot spell something unfortunate.
 */
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
/** Check symbols extend the alphabet to 37 values. */
const CHECK_ALPHABET = `${ALPHABET}*~$=U`;

/** The 32-byte key that actually encrypts a blob. */
export function generateBackupKey(): Uint8Array {
  return randomBytes(BACKUP_KEY_BYTES);
}

/**
 * Crockford's mod-37 check symbol, computed without BigInt — `acc` never
 * exceeds 37*256, so plain integer maths is exact and Hermes-safe.
 */
function checkSymbol(bytes: Uint8Array): string {
  let acc = 0;
  for (const b of bytes) acc = (acc * 256 + b) % 37;
  return CHECK_ALPHABET[acc];
}

/**
 * Encode a key as the string the user writes down: 52 Base32 characters plus a
 * check symbol, hyphenated in groups of 5 so it can be read aloud and copied by
 * hand without losing your place.
 */
export function encodeRecoveryCode(key: Uint8Array): string {
  if (key.length !== BACKUP_KEY_BYTES) {
    throw new Error(`Recovery code needs a ${BACKUP_KEY_BYTES}-byte key, got ${key.length}`);
  }
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of key) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  // 256 bits is not a multiple of 5, so the last 1 bit is left-padded into a
  // final symbol. decodeRecoveryCode discards it symmetrically.
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];

  const withCheck = out + checkSymbol(key);
  return (withCheck.match(/.{1,5}/g) ?? []).join('-');
}

/**
 * Decode a recovery code the user typed. Returns null on anything unusable
 * rather than throwing, because every failure here is a user typo and the
 * caller's job is to say "that code isn't right", not to crash.
 *
 * Normalisation is the point of Crockford: `I`/`L` read as `1`, `O` as `0`,
 * case is irrelevant, and hyphens and spaces are noise.
 */
export function decodeRecoveryCode(code: string): Uint8Array | null {
  const cleaned = (code ?? '')
    .toUpperCase()
    .replace(/[\s-]/g, '')
    .replace(/[IL]/g, '1')
    .replace(/O/g, '0');
  if (cleaned.length < 2) return null;

  const body = cleaned.slice(0, -1);
  const check = cleaned.slice(-1);

  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of body) {
    const idx = ALPHABET.indexOf(ch);
    if (idx === -1) return null;
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  if (out.length !== BACKUP_KEY_BYTES) return null;

  const key = Uint8Array.from(out);
  // Checked LAST: a code of the right shape but one wrong character is the
  // common case, and this is the only thing that catches it before a restore
  // fails with a far less helpful "wrong key".
  if (checkSymbol(key) !== check) return null;
  return key;
}

/**
 * Derive a key-encryption key from a passphrase, for the optional escrow path.
 *
 * **Cost comes from `params` and is never defaulted here.** The right cost is a
 * measurement, not a constant: `lib/security/pin-service.ts:8-24` records that
 * JS scrypt on Hermes cost *seconds per hash* and shipped a PIN-latency bug.
 * The budget for a backup passphrase is different from the PIN's — it is
 * derived twice in a lifetime rather than on every unlock, so it can afford to
 * be far slower — but "different" is not "unmeasured", and a constant chosen
 * here would be a guess wearing a number's clothes.
 */
export async function deriveKek(passphrase: string, params: KdfParams): Promise<Uint8Array> {
  const salt = Uint8Array.from(atob(params.salt), (c) => c.charCodeAt(0));
  const pass = new TextEncoder().encode(passphrase.normalize('NFKC'));

  if (params.name === 'scrypt') {
    return scryptAsync(pass, salt, {
      N: params.cost,
      r: params.blockSize ?? 8,
      p: params.parallelism ?? 1,
      dkLen: 32,
    });
  }
  return pbkdf2Async(sha256, pass, salt, { c: params.cost, dkLen: 32 });
}

/** Wrap the backup key under a passphrase-derived KEK. Output: nonce ‖ ct+tag. */
export function wrapKey(kek: Uint8Array, key: Uint8Array): Uint8Array {
  const nonce = randomBytes(NONCE_BYTES);
  const ct = xchacha20poly1305(kek, nonce).encrypt(key);
  const out = new Uint8Array(nonce.length + ct.length);
  out.set(nonce, 0);
  out.set(ct, nonce.length);
  return out;
}

/**
 * Reverse `wrapKey`. Returns null on a wrong passphrase or a tampered blob —
 * the AEAD tag makes those indistinguishable, which is the correct amount of
 * information to give back.
 */
export function unwrapKey(kek: Uint8Array, wrapped: Uint8Array): Uint8Array | null {
  if (wrapped.length <= NONCE_BYTES) return null;
  try {
    const nonce = wrapped.subarray(0, NONCE_BYTES);
    const ct = wrapped.subarray(NONCE_BYTES);
    const key = xchacha20poly1305(kek, nonce).decrypt(ct);
    return key.length === BACKUP_KEY_BYTES ? key : null;
  } catch {
    return null;
  }
}
