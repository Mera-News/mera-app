// Backup crypto: the key and the recovery code the user writes down.
//
// The key model was decided with the user: a device-generated 32-byte key,
// shown once as a recovery code. The server never sees it. A "token generated
// after login" was rejected precisely because it would let the server decrypt,
// which would make the backup a copy of the data the privacy invariant says the
// server must not hold.
//
// **The recovery code IS the key.** There is no passphrase, no KDF and no server
// round-trip anywhere in this file, which is what makes it small.
//
// An optional passphrase escrow was designed and then dropped from v1
// (2026-08-17): it would have wrapped this key under a passphrase-derived KEK
// and parked the wrapper server-side for users who lose their code. It was the
// only thing here needing a *measured* KDF cost — human passphrases are
// guessable, the wrapper would be guessable offline, and a rate limit on our
// side is powerless against that, so the derivation has to be deliberately slow
// and "slow" is a number you get from a device, not from a keyboard. If it ever
// returns, `BackupHeader.algo` is the upgrade path, `@noble/hashes` ships
// `argon2.js` (the option the plan recommends), and the server half is built and
// parked on `mera-server` branch `backup-escrow`.
//
// Primitives are reused from what `lib/e2ee/e2ee-service.ts` already ships —
// same libraries, same `.js` subpath import style — rather than introducing a
// second crypto stack alongside it.

import { randomBytes } from '@noble/ciphers/utils.js';

export const BACKUP_KEY_BYTES = 32;

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
