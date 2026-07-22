// pin-service tests. The secure-store adapter is mocked with an in-memory map
// so we exercise the real scrypt hashing + attempt-limiting logic end to end.

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
