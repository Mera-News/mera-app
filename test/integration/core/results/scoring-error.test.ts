// scoring-error: classification behind the For You header status copy. Real network-store, real i18n.
import i18n from '@/lib/i18n';
import { classifyScoringError, SCORING_ERROR_I18N_KEYS } from '@/lib/services/scoring-error';
import { useNetworkStore } from '@/lib/stores/network-store';
import { initI18nEn } from '@/test/helpers';

afterEach(() => useNetworkStore.getState().setIsConnected(true));

describe('classifyScoringError', () => {
  it("returns 'server' when the device is connected", () => {
    useNetworkStore.getState().setIsConnected(true);
    expect(classifyScoringError()).toBe('server');
  });

  it("returns 'offline' when the device is not connected", () => {
    useNetworkStore.getState().setIsConnected(false);
    expect(classifyScoringError()).toBe('offline');
  });

  it('reads the store at call time, so a reconnect flips the verdict back', () => {
    useNetworkStore.getState().setIsConnected(false);
    expect(classifyScoringError()).toBe('offline');
    useNetworkStore.getState().setIsConnected(true);
    expect(classifyScoringError()).toBe('server');
  });

  it('ignores the server-reachability flag: only device connectivity decides', () => {
    useNetworkStore.getState().setIsConnected(true);
    useNetworkStore.getState().setServerReachable(false);
    try {
      expect(classifyScoringError()).toBe('server');
    } finally {
      useNetworkStore.getState().setServerReachable(true);
    }
  });
});

describe('SCORING_ERROR_I18N_KEYS', () => {
  it('has a title and message key for every kind', () => {
    for (const kind of ['offline', 'server', 'generic'] as const) {
      expect(SCORING_ERROR_I18N_KEYS[kind].title).toMatch(/^errors\.scoring\./);
      expect(SCORING_ERROR_I18N_KEYS[kind].message).toMatch(/^errors\.scoring\./);
    }
  });

  it('every key resolves to English copy in the shipped locale, not to the key itself', async () => {
    await initI18nEn();
    for (const kind of ['offline', 'server', 'generic'] as const) {
      for (const key of [SCORING_ERROR_I18N_KEYS[kind].title, SCORING_ERROR_I18N_KEYS[kind].message]) {
        const copy = i18n.t(key);
        expect(copy).not.toBe(key);
        expect(copy.length).toBeGreaterThan(0);
      }
    }
  });
});
