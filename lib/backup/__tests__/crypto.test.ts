// The recovery code is the only thing standing between a user and permanent
// loss of their persona, and it is transcribed BY HAND from a screen. So the
// tests that matter here are the human-error ones: a mistyped character, a
// confused I/1, a lowercase paste. Each must be caught by the checksum rather
// than surfacing three steps later as an unhelpful "wrong key".

import {
  BACKUP_KEY_BYTES,
  decodeRecoveryCode,
  encodeRecoveryCode,
  generateBackupKey,
} from '../crypto';

const KEY = Uint8Array.from({ length: 32 }, (_, i) => i * 7 + 3);

describe('generateBackupKey', () => {
  it('returns 32 bytes', () => {
    expect(generateBackupKey()).toHaveLength(BACKUP_KEY_BYTES);
  });

  it('does not return the same key twice', () => {
    expect(Array.from(generateBackupKey())).not.toEqual(Array.from(generateBackupKey()));
  });
});

describe('recovery code round-trip', () => {
  it('decodes what it encoded', () => {
    expect(Array.from(decodeRecoveryCode(encodeRecoveryCode(KEY))!)).toEqual(Array.from(KEY));
  });

  it('survives a random key, not just a patterned one', () => {
    const key = generateBackupKey();
    expect(Array.from(decodeRecoveryCode(encodeRecoveryCode(key))!)).toEqual(Array.from(key));
  });

  it('is hyphenated in groups of five so it can be copied by hand', () => {
    const code = encodeRecoveryCode(KEY);
    const groups = code.split('-');
    expect(groups.every((g) => g.length <= 5)).toBe(true);
    // 32 bytes -> 52 base32 symbols + 1 check symbol.
    expect(code.replace(/-/g, '')).toHaveLength(53);
  });

  it('refuses to encode a key of the wrong size', () => {
    expect(() => encodeRecoveryCode(new Uint8Array(16))).toThrow('32-byte key');
  });
});

describe('recovery code normalisation — the point of Crockford', () => {
  const code = encodeRecoveryCode(KEY);

  it('accepts lowercase', () => {
    expect(Array.from(decodeRecoveryCode(code.toLowerCase())!)).toEqual(Array.from(KEY));
  });

  it('ignores hyphens and spaces however the user grouped them', () => {
    expect(Array.from(decodeRecoveryCode(code.replace(/-/g, ''))!)).toEqual(Array.from(KEY));
    expect(Array.from(decodeRecoveryCode(code.replace(/-/g, ' '))!)).toEqual(Array.from(KEY));
  });

  it('reads I and L as 1, and O as 0', () => {
    // The alphabet excludes I/L/O precisely so they can be remapped on input.
    const typed = code.replace(/1/g, 'I').replace(/0/g, 'O');
    expect(Array.from(decodeRecoveryCode(typed)!)).toEqual(Array.from(KEY));
    expect(Array.from(decodeRecoveryCode(code.replace(/1/g, 'l'))!)).toEqual(Array.from(KEY));
  });
});

describe('recovery code rejects bad input instead of returning a wrong key', () => {
  const code = encodeRecoveryCode(KEY);

  it('catches a single mistyped character', () => {
    const body = code.replace(/-/g, '');
    // Flip one symbol in the body to a different valid symbol.
    const at = 10;
    const wrong = body[at] === '2' ? '3' : '2';
    const typo = body.slice(0, at) + wrong + body.slice(at + 1);
    expect(decodeRecoveryCode(typo)).toBeNull();
  });

  it('catches a wrong check symbol', () => {
    const body = code.replace(/-/g, '');
    const bad = body.slice(0, -1) + (body.at(-1) === 'Z' ? 'Y' : 'Z');
    expect(decodeRecoveryCode(bad)).toBeNull();
  });

  it('rejects a code of the wrong length', () => {
    expect(decodeRecoveryCode(code.replace(/-/g, '').slice(0, 40))).toBeNull();
  });

  it('rejects characters outside the alphabet', () => {
    expect(decodeRecoveryCode('U'.repeat(53))).toBeNull();
  });

  it('rejects empty and near-empty input rather than throwing', () => {
    expect(decodeRecoveryCode('')).toBeNull();
    expect(decodeRecoveryCode('A')).toBeNull();
    expect(decodeRecoveryCode('--')).toBeNull();
  });
});
