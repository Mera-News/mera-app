// publication-display-service.test.ts: the ports behind the publication
// display-name store (ux2 A6): the GraphQL fetch, the settings-table cache and
// the app-language wiring.

const mockQuery = jest.fn();
const mockGetSetting = jest.fn();
const mockSetSetting = jest.fn();

jest.mock('@/lib/apollo-client', () => ({
  __esModule: true,
  default: { query: (...a: unknown[]) => mockQuery(...a) },
}));
jest.mock('@/lib/database/services/setting-service', () => ({
  getSetting: (...a: unknown[]) => mockGetSetting(...a),
  setSetting: (...a: unknown[]) => mockSetSetting(...a),
}));
jest.mock('@/lib/logger', () => ({
  __esModule: true,
  default: { captureException: jest.fn(), warn: jest.fn(), debug: jest.fn(), info: jest.fn() },
}));
jest.mock('@/lib/stores/app-language-store', () => {
  const { create } = jest.requireActual('zustand');
  return { useAppLanguageStore: create(() => ({ appLanguage: 'en' })) };
});

import { act } from '@testing-library/react-native';
import {
  fetchPublicationDisplayNames,
  installPublicationDisplayNames,
  publicationDisplayCacheKey,
  publicationDisplayPorts,
  serverLocaleFor,
} from '../publication-display-service';
import { useAppLanguageStore } from '@/lib/stores/app-language-store';
import { createPublicationDisplayStore } from '@/lib/stores/publication-display-store';

function answer(pairs: [string, string][]) {
  return {
    data: { publicationDisplayNames: pairs.map(([name, displayName]) => ({ name, displayName })) },
  };
}

describe('publication-display-service', () => {
  beforeEach(() => {
    mockQuery.mockReset();
    mockGetSetting.mockReset();
    mockSetSetting.mockReset();
  });

  describe('serverLocaleFor: app language code -> the server map key', () => {
    it('maps the three codes the app and the server spell differently', () => {
      expect(serverLocaleFor('pt')).toBe('pt-BR');
      expect(serverLocaleFor('zh-Hans')).toBe('zh-CN');
      expect(serverLocaleFor('zh-Hant')).toBe('zh-TW');
    });
    it('passes every other app language through', () => {
      for (const code of ['en', 'de', 'fr', 'es', 'it', 'nl', 'pl', 'tr', 'id', 'vi', 'ru', 'uk', 'ar', 'hi', 'th', 'ja', 'ko']) {
        expect(serverLocaleFor(code)).toBe(code);
      }
    });
  });

  describe('fetchPublicationDisplayNames', () => {
    it('asks in the server locale and returns raw name -> display name', async () => {
      mockQuery.mockResolvedValue(answer([['人民日报', '人民日报']]));
      const out = await fetchPublicationDisplayNames('zh-Hans', ['人民日报']);
      expect(out).toEqual({ '人民日报': '人民日报' });
      const call = mockQuery.mock.calls[0][0];
      expect(call.variables).toEqual({ language: 'zh-CN', names: ['人民日报'] });
      expect(call.fetchPolicy).toBe('no-cache');
      // Not part of the feed sync: a failure (a server without the query yet)
      // must never paint the feed-wide "sync failed" banner.
      expect(call.context).toEqual(expect.objectContaining({ noSyncStatus: true }));
    });

    it('splits more than 200 names into several calls', async () => {
      mockQuery.mockImplementation(async ({ variables }: { variables: { names: string[] } }) =>
        answer(variables.names.map((n) => [n, n.toUpperCase()])),
      );
      const names = Array.from({ length: 450 }, (_, i) => `pub ${i}`);
      const out = await fetchPublicationDisplayNames('en', names);
      expect(mockQuery).toHaveBeenCalledTimes(3);
      expect(mockQuery.mock.calls.map((c) => c[0].variables.names.length)).toEqual([200, 200, 50]);
      expect(out['pub 449']).toBe('PUB 449');
    });

    it('ignores an empty display name rather than showing a blank', async () => {
      mockQuery.mockResolvedValue(answer([['Le Monde', '']]));
      expect(await fetchPublicationDisplayNames('ru', ['Le Monde'])).toEqual({});
    });

    it('rejects when the call fails, so the store can retry', async () => {
      mockQuery.mockRejectedValue(new Error('Network request failed'));
      await expect(fetchPublicationDisplayNames('en', ['x'])).rejects.toThrow();
    });
  });

  describe('cache ports (settings table, one JSON key per language)', () => {
    it('keys by app language', () => {
      expect(publicationDisplayCacheKey('zh-Hant')).toBe('publication_display_names:zh-Hant');
    });

    it('round-trips a map', async () => {
      const entry = { savedAt: 123, names: { '人民日报': 'Renmin Ribao' } };
      await publicationDisplayPorts.save('en', entry);
      expect(mockSetSetting).toHaveBeenCalledWith('publication_display_names:en', JSON.stringify(entry));
      mockGetSetting.mockResolvedValue(JSON.stringify(entry));
      expect(await publicationDisplayPorts.load('en')).toEqual(entry);
    });

    it('treats a missing or corrupt row as no cache', async () => {
      mockGetSetting.mockResolvedValue(null);
      expect(await publicationDisplayPorts.load('en')).toBeNull();
      mockGetSetting.mockResolvedValue('{not json');
      expect(await publicationDisplayPorts.load('en')).toBeNull();
      mockGetSetting.mockResolvedValue(JSON.stringify({ savedAt: 'x', names: [] }));
      expect(await publicationDisplayPorts.load('en')).toBeNull();
    });
  });

  describe('installPublicationDisplayNames', () => {
    it('adopts the current app language and follows every change', async () => {
      mockGetSetting.mockResolvedValue(null);
      const store = createPublicationDisplayStore();
      await act(async () => {
        await installPublicationDisplayNames(store, useAppLanguageStore as never);
      });
      expect(store.getState().language).toBe('en');
      await act(async () => {
        useAppLanguageStore.setState({ appLanguage: 'ja' });
        await Promise.resolve();
      });
      expect(store.getState().language).toBe('ja');
    });

    it('installing twice keeps one subscription', async () => {
      mockGetSetting.mockResolvedValue(null);
      const store = createPublicationDisplayStore();
      const setLanguage = jest.spyOn(store.getState(), 'setLanguage');
      await act(async () => {
        await installPublicationDisplayNames(store, useAppLanguageStore as never);
        await installPublicationDisplayNames(store, useAppLanguageStore as never);
      });
      setLanguage.mockClear();
      await act(async () => {
        useAppLanguageStore.setState({ appLanguage: 'de' });
        await Promise.resolve();
      });
      expect(setLanguage).toHaveBeenCalledTimes(1);
    });
  });
});
