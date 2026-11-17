// scoring-error: classification behind the For You header status copy. Real network-store, real i18n.
import i18n from '@/lib/i18n';
import { SCORING_ERROR_I18N_KEYS } from '@/lib/services/scoring-error';
import { useNetworkStore } from '@/lib/stores/network-store';
import { initI18nEn } from '@/test/helpers';

afterEach(() => useNetworkStore.getState().setIsConnected(true));

describe('SCORING_ERROR_I18N_KEYS', () => {

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
