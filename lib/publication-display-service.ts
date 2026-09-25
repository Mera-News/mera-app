// publication-display-service: the network and cache side of the publication
// display-name store (lib/stores/publication-display-store.ts, ux2 A6).
//
// - fetch: the `publicationDisplayNames(language, names)` query. The server
//   returns `publication_name_i18n[language]`, falling back to the name.
// - cache: one JSON row per app language in the settings table. No new table,
//   no migration, no article column.
// - install: wires both into the store and makes it follow the app language.
//   Called once from hydrateAllStores, after the app language has hydrated.
//
// The store never imports this file (the card graph must stay free of Apollo
// and the database), so a card test never touches the network.

import { gql } from '@apollo/client';
import client from '@/lib/apollo-client';
import logger from '@/lib/logger';
import { getSetting, setSetting } from '@/lib/database/services/setting-service';
import { useAppLanguageStore } from '@/lib/stores/app-language-store';
import type {
  PublicationDisplayName,
  QueryPublicationDisplayNamesArgs,
} from '@/lib/generated/graphql-types';
import {
  PUBLICATION_DISPLAY_BATCH_MAX,
  usePublicationDisplayStore,
  type PublicationDisplayCache,
  type PublicationDisplayPorts,
  type PublicationDisplayStore,
} from '@/lib/stores/publication-display-store';

const PUBLICATION_DISPLAY_NAMES = gql`
  query PublicationDisplayNames($language: String!, $names: [String!]!) {
    publicationDisplayNames(language: $language, names: $names) {
      name
      displayName
    }
  }
`;

/**
 * The app's language codes are the iOS ones (SUPPORTED_LANGUAGES); the server
 * keys `publication_name_i18n` by its own locale list and looks the code up
 * as given. Three are spelled differently. Unmapped, Portuguese and both
 * Chinese scripts would silently get raw names.
 */
const SERVER_LOCALE: Record<string, string> = {
  pt: 'pt-BR',
  'zh-Hans': 'zh-CN',
  'zh-Hant': 'zh-TW',
};

export function serverLocaleFor(appLanguage: string): string {
  return SERVER_LOCALE[appLanguage] ?? appLanguage;
}

/** raw name -> display name, in the app language given. Rejects on failure. */
export async function fetchPublicationDisplayNames(
  appLanguage: string,
  names: readonly string[],
): Promise<Record<string, string>> {
  const language = serverLocaleFor(appLanguage);
  const out: Record<string, string> = {};
  for (let i = 0; i < names.length; i += PUBLICATION_DISPLAY_BATCH_MAX) {
    const variables: QueryPublicationDisplayNamesArgs = {
      language,
      names: names.slice(i, i + PUBLICATION_DISPLAY_BATCH_MAX),
    };
    const { data } = await client.query<{ publicationDisplayNames: PublicationDisplayName[] }>({
      query: PUBLICATION_DISPLAY_NAMES,
      variables,
      // The store and its settings row are the cache; Apollo's would only be
      // a second, unbounded copy.
      fetchPolicy: 'no-cache',
    });
    for (const row of data?.publicationDisplayNames ?? []) {
      if (row?.name && row.displayName) out[row.name] = row.displayName;
    }
  }
  return out;
}

export function publicationDisplayCacheKey(appLanguage: string): string {
  return `publication_display_names:${appLanguage}`;
}

function parseCache(raw: string | null): PublicationDisplayCache | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<PublicationDisplayCache> | null;
    if (
      !parsed ||
      typeof parsed.savedAt !== 'number' ||
      !parsed.names ||
      typeof parsed.names !== 'object' ||
      Array.isArray(parsed.names)
    ) {
      return null;
    }
    return { savedAt: parsed.savedAt, names: parsed.names };
  } catch {
    return null;
  }
}

export const publicationDisplayPorts: PublicationDisplayPorts = {
  fetch: fetchPublicationDisplayNames,
  load: async (appLanguage) => parseCache(await getSetting(publicationDisplayCacheKey(appLanguage))),
  save: async (appLanguage, entry) => {
    try {
      await setSetting(publicationDisplayCacheKey(appLanguage), JSON.stringify(entry));
    } catch (err) {
      // A lost write only costs one refetch next launch.
      logger.warn('[publication-display] cache write failed', { error: String(err) });
    }
  },
};

type LanguageSource = Pick<typeof useAppLanguageStore, 'getState' | 'subscribe'>;

let unsubscribeLanguage: (() => void) | null = null;

/**
 * Wire the store: inject the ports, adopt the current app language and follow
 * every change. Safe to call again (a re-hydrate): the previous subscription
 * is replaced, never doubled.
 */
export function installPublicationDisplayNames(
  store: PublicationDisplayStore = usePublicationDisplayStore,
  languages: LanguageSource = useAppLanguageStore,
): Promise<void> {
  store.getState().configure(publicationDisplayPorts);
  unsubscribeLanguage?.();
  unsubscribeLanguage = languages.subscribe((s, prev) => {
    if (s.appLanguage !== prev.appLanguage) void store.getState().setLanguage(s.appLanguage);
  });
  return store.getState().setLanguage(languages.getState().appLanguage);
}
