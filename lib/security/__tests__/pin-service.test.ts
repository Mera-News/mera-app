// pin-service tests. The secure-store adapter is mocked with an in-memory map
// so we exercise the real hashing + attempt-limiting logic end to end.
//
// expo-crypto's native digestStringAsync isn't available under Jest, and the
// global jest.setup.js mock returns a constant 'deadbeef' regardless of
// input — fine for smoke tests elsewhere, but useless here since we need
// different (salt, pin) pairs to produce different digests (otherwise a
// wrong PIN would "verify" as correct). This file-local mock overrides it
// with a small deterministic hash that's a pure function of the input
// string, which is all these tests need.

const mockStore = new Map<string, string>();

jest.mock('../../utils/secure-store-adapter', () => ({
  secureStore: {
    getItemAsync: (k: string) => Promise.resolve(mockStore.has(k) ? mockStore.get(k)! : null),
    setItemAsync: (k: string, v: string) => {
      mockStore.set(k, v);
      return Promise.resolve();
    },
    deleteItemAsync: (k: string) => {
      mockStore.delete(k);
      return Promise.resolve();
    },
  },
}));

jest.mock('expo-constants', () => ({
  __esModule: true,
  default: { expoConfig: { slug: 'testslug' } },
}));

jest.mock('expo-crypto', () => ({
  CryptoDigestAlgorithm: { SHA256: 'SHA-256' },
  digestStringAsync: jest.fn((_algo: string, data: string) => {
    let h = 0;
    for (let i = 0; i < data.length; i++) {
      h = (h * 31 + data.charCodeAt(i)) >>> 0;
    }
    return Promise.resolve(h.toString(16).padStart(8, '0'));
  }),
}));

jest.mock('../../logger', () => ({
  __esModule: true,
  default: { captureException: jest.fn(), info: jest.fn(), warn: jest.fn() },
}));

import {
  changePin,
  clearPin,
  cooldownForFailCount,
  getCooldownRemainingMs,
  isPinSet,
  setPin,
  verifyPin,
} from '../pin-service';

beforeEach(() => {
  mockStore.clear();
  jest.useRealTimers();
});

describe('setPin / verifyPin roundtrip', () => {
  it('isPinSet is false before, true after setPin', async () => {
    expect(await isPinSet()).toBe(false);
    await setPin('1234');
    expect(await isPinSet()).toBe(true);
  });

  it('verifies the correct PIN and rejects a wrong one', async () => {
    await setPin('4821');
    expect((await verifyPin('4821')).success).toBe(true);
    expect((await verifyPin('0000')).success).toBe(false);
  });

  it('stores a salt + hash, never the raw PIN', async () => {
    await setPin('1234');
    const raw = mockStore.get('testslug_pin_record')!;
    expect(raw).not.toContain('1234');
    const rec = JSON.parse(raw);
    expect(rec.saltHex).toMatch(/^[0-9a-f]+$/);
    expect(rec.hashHex).toMatch(/^[0-9a-f]+$/);
    expect(typeof rec.createdAt).toBe('number');
  });

  it('a correct attempt resets the failure counter', async () => {
    await setPin('1234');
    await verifyPin('0000');
    await verifyPin('0000');
    const ok = await verifyPin('1234');
    expect(ok.success).toBe(true);
    expect(ok.failCount).toBe(0);
    // subsequent state clean
    expect(await getCooldownRemainingMs()).toBe(0);
  });
});

describe('cooldownForFailCount', () => {
  it('only arms on multiples of 5, escalating 30s → 60s → 5min', () => {
    expect(cooldownForFailCount(1)).toBe(0);
    expect(cooldownForFailCount(4)).toBe(0);
    expect(cooldownForFailCount(5)).toBe(30_000);
    expect(cooldownForFailCount(9)).toBe(0);
    expect(cooldownForFailCount(10)).toBe(60_000);
    expect(cooldownForFailCount(15)).toBe(5 * 60_000);
    expect(cooldownForFailCount(20)).toBe(5 * 60_000);
    expect(cooldownForFailCount(0)).toBe(0);
  });
});

describe('escalating cooldown + persistence', () => {
  it('arms a 30s lockout after 5 wrong attempts and blocks entry while locked', async () => {
    await setPin('1234');
    let res;
    for (let i = 0; i < 5; i++) res = await verifyPin('0000');
    expect(res!.failCount).toBe(5);
    expect(res!.remainingMs).toBeGreaterThan(0);
    expect(res!.lockedUntil).toBeGreaterThan(Date.now());

    // Even the CORRECT pin is rejected while locked out.
    const duringLock = await verifyPin('1234');
    expect(duringLock.success).toBe(false);
    expect(duringLock.remainingMs).toBeGreaterThan(0);
  });

  it('persists attempt state across "relaunch" (state lives in the store map)', async () => {
    await setPin('1234');
    for (let i = 0; i < 5; i++) await verifyPin('0000');
    // A fresh read (simulating relaunch — module state is not in memory) still
    // sees the lockout because it is persisted in secure store.
    const remaining = await getCooldownRemainingMs();
    expect(remaining).toBeGreaterThan(0);
    expect(mockStore.has('testslug_pin_attempts')).toBe(true);
  });

  it('lockout lifts after the cooldown elapses, then allows entry', async () => {
    await setPin('1234');
    for (let i = 0; i < 5; i++) await verifyPin('0000');

    // Fast-forward past the 30s cooldown by rewriting the persisted lockedUntil
    // into the past (equivalent to wall-clock advancing).
    const attempts = JSON.parse(mockStore.get('testslug_pin_attempts')!);
    attempts.lockedUntil = Date.now() - 1;
    mockStore.set('testslug_pin_attempts', JSON.stringify(attempts));

    expect(await getCooldownRemainingMs()).toBe(0);
    expect((await verifyPin('1234')).success).toBe(true);
  });
});

describe('changePin', () => {
  it('rejects when the current PIN is wrong', async () => {
    await setPin('1111');
    const res = await changePin('9999', '2222');
    expect(res.success).toBe(false);
    // old PIN still valid
    expect((await verifyPin('1111')).success).toBe(true);
  });

  it('changes the PIN when the current PIN is correct', async () => {
    await setPin('1111');
    const res = await changePin('1111', '2222');
    expect(res.success).toBe(true);
    expect((await verifyPin('2222')).success).toBe(true);
    expect((await verifyPin('1111')).success).toBe(false);
  });
});

describe('legacy (pre sha256-v1) records', () => {
  const legacyRecord = () =>
    JSON.stringify({
      // Old scrypt-era shape: no `algo` field at all (records written before
      // this field existed) — the mismatch check must treat this the same as
      // an explicitly different algo value.
      saltHex: 'aa'.repeat(16),
      hashHex: 'bb'.repeat(32),
      createdAt: Date.now(),
    });

  it('isPinSet treats an algo-mismatched record as if no PIN were set', async () => {
    mockStore.set('testslug_pin_record', legacyRecord());
    expect(await isPinSet()).toBe(false);
  });

  it('verifyPin rejects a legacy record without burning an attempt or arming a cooldown', async () => {
    mockStore.set('testslug_pin_record', legacyRecord());
    const res = await verifyPin('1234');
    expect(res.success).toBe(false);
    expect(res.failCount).toBe(0);
    expect(res.lockedUntil).toBeUndefined();
    // No attempt-state was even written — a legacy record shouldn't count
    // against the cooldown budget since it can never be satisfied.
    expect(mockStore.has('testslug_pin_attempts')).toBe(false);
  });

  it('an explicit non-current algo value is treated the same as a missing one', async () => {
    mockStore.set(
      'testslug_pin_record',
      JSON.stringify({
        algo: 'scrypt-legacy',
        saltHex: 'aa'.repeat(16),
        hashHex: 'bb'.repeat(32),
        createdAt: Date.now(),
      }),
    );
    expect(await isPinSet()).toBe(false);
    expect((await verifyPin('1234')).success).toBe(false);
  });

  it('self-heals: setPin after a legacy record overwrites it with the current algo', async () => {
    mockStore.set('testslug_pin_record', legacyRecord());
    expect(await isPinSet()).toBe(false);

    await setPin('1234');

    expect(await isPinSet()).toBe(true);
    expect((await verifyPin('1234')).success).toBe(true);
    const rec = JSON.parse(mockStore.get('testslug_pin_record')!);
    expect(rec.algo).toBe('sha256-v1');
  });
});

describe('clearPin', () => {
  it('removes the record and attempt state', async () => {
    await setPin('1234');
    await verifyPin('0000');
    await clearPin();
    expect(await isPinSet()).toBe(false);
    expect(mockStore.has('testslug_pin_record')).toBe(false);
    expect(mockStore.has('testslug_pin_attempts')).toBe(false);
  });
});
