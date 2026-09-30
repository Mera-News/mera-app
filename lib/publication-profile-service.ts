// publication-profile-service: what the publication page knows about ONE
// publication (name, website, type, languages, categories, official flag,
// country, and every source name it publishes under).
//
// Keyed by either the publisher id (Sources rows, article detail) or the raw
// name plus country a feed row carries (cards: feed rows have no publication
// id). Never a feed id. The server collapses a name + country onto its
// publisher.
//
// - `no-cache`: the page is opened on a tap and shows current catalogue data.
//   Nothing is persisted here; the only thing kept is the publisher's source
//   names, in memory (publisher-source-names.ts), so more/fewer can reach every
//   name without another request.
// - `GRAPHQL_VALIDATION_FAILED` means this bundle is ahead of its server (an
//   OTA shipped before `publicationProfile` was live). That is `unsupported`
//   for the rest of the session, never persisted, and never a Sentry event
//   (`expectedErrorCodes`). The page then shows what its entry point knew.
// - Offline is decided before any request (`isConnected === false`, the raw
//   device link, never the `isOnline()` latch) and is left the moment the link
//   returns.
//
// The network and the device checks are PORTS, injected, so the hook can be
// tested without Apollo, the database or NetInfo. The default ports require
// those lazily for the same reason.

import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { gql } from '@apollo/client';
import logger from '@/lib/logger';
import { rememberPublisherSourceNames } from '@/lib/database/services/publisher-source-names';
import type { QueryPublicationProfileArgs } from '@/lib/generated/graphql-types';

/** One publication, as the page shows it. */
export interface PublicationProfile {
  newsPublisherId: string;
  name: string;
  /** The name in the reader's language, when the server has one. */
  displayName: string | null;
  homepageUrl: string | null;
  publicationType: string | null;
  categories: string[];
  languages: string[];
  /** A government or regulator publication. */
  isOfficial: boolean;
  countryCode: string;
  countryName: string | null;
  /** Every source `publication_name` under this publisher. Keys more/fewer. */
  sourceNames: string[];
  /** The publisher's own subscribe page, or null when it has none. */
  subscriptionUri: string | null;
}

/** How the page was opened: a publisher id, or the name + country a feed row carries. */
export type PublicationProfileKey =
  | { readonly publisherId: string }
  | { readonly rawName: string; readonly countryCode: string | null | undefined };

export type PublicationProfileState =
  | 'loading'
  | 'ready'
  | 'error'
  | 'offline'
  | 'unsupported'
  | 'notFound';

export interface PublicationProfileResult {
  state: PublicationProfileState;
  /** Set only in `ready`. */
  profile: PublicationProfile | null;
  /** Ask again (after `error`, or `offline` once the link is back). */
  retry: () => void;
}

/** The server does not know `publicationProfile` (an app ahead of its server). */
export class PublicationProfileUnsupportedError extends Error {
  readonly unsupported = true as const;
  constructor() {
    super('publicationProfile is not supported by this server');
    this.name = 'PublicationProfileUnsupportedError';
  }
}

export interface PublicationProfilePorts {
  /** Null when no publication matches the key. Rejects with
   *  {@link PublicationProfileUnsupportedError} on an unknown query. */
  fetch(key: PublicationProfileKey, appLanguage: string): Promise<PublicationProfile | null>;
  /** True only when the device link is known to be down. */
  isOffline(): boolean;
  /** Calls back when the device link comes back. Returns an unsubscribe. */
  onReconnect(listener: () => void): () => void;
}

export const PUBLICATION_PROFILE = gql`
  query PublicationProfile(
    $newsPublisherId: ID
    $name: String
    $countryCode: String
    $language: String
  ) {
    publicationProfile(
      newsPublisherId: $newsPublisherId
      name: $name
      countryCode: $countryCode
      language: $language
    ) {
      newsPublisherId
      name
      displayName
      homepageUrl
      publicationType
      categories
      languages
      isOfficial
      countryCode
      countryName
      sourceNames
      subscriptionUri
    }
  }
`;

/** GraphQL error codes on a rejection (Apollo 4 `errors`, Apollo 3 `graphQLErrors`). */
function graphQLErrorCodes(err: unknown): string[] {
  if (!err || typeof err !== 'object') return [];
  const list = (err as { errors?: unknown }).errors ?? (err as { graphQLErrors?: unknown }).graphQLErrors;
  if (!Array.isArray(list)) return [];
  return list
    .map((e) => (e as { extensions?: { code?: unknown } })?.extensions?.code)
    .filter((c): c is string => typeof c === 'string');
}

function strings(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x.length > 0) : [];
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null;
}

/** Defensive shape check: a partial or malformed row is "not found", never a crash. */
export function toPublicationProfile(raw: unknown): PublicationProfile | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const id = str(r.newsPublisherId);
  const name = str(r.name);
  if (!id || !name) return null;
  return {
    newsPublisherId: id,
    name,
    displayName: str(r.displayName),
    homepageUrl: str(r.homepageUrl),
    publicationType: str(r.publicationType),
    categories: strings(r.categories),
    languages: strings(r.languages),
    isOfficial: r.isOfficial === true,
    countryCode: str(r.countryCode) ?? '',
    countryName: str(r.countryName),
    sourceNames: strings(r.sourceNames),
    subscriptionUri: str(r.subscriptionUri),
  };
}

/** The variables for a key: exactly one of the two modes, as the server requires. */
export function profileVariables(key: PublicationProfileKey, language: string): QueryPublicationProfileArgs {
  // Exactly one key mode: the server answers BAD_PROFILE_KEY to a mix.
  const vars: QueryPublicationProfileArgs = { language };
  if ('publisherId' in key) {
    vars.newsPublisherId = key.publisherId;
  } else {
    vars.name = key.rawName;
    if (key.countryCode) vars.countryCode = key.countryCode;
  }
  return vars;
}

/** The network half of the default ports. Exported for tests. */
export async function fetchPublicationProfile(
  key: PublicationProfileKey,
  appLanguage: string,
): Promise<PublicationProfile | null> {
  // Required here, not at the top: Apollo and the language map pull in the
  // database and endpoint config, which the hook's own tests must not load.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const client = (require('@/lib/apollo-client') as typeof import('@/lib/apollo-client')).default;
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { serverLocaleFor } = require('@/lib/publication-display-service') as typeof import('@/lib/publication-display-service');
  try {
    const { data } = await client.query<{ publicationProfile: unknown }>({
      query: PUBLICATION_PROFILE,
      variables: profileVariables(key, serverLocaleFor(appLanguage)),
      fetchPolicy: 'no-cache',
      // Not the feed sync: a failure must never paint "sync failed". A server
      // without the query answers GRAPHQL_VALIDATION_FAILED, which is handled
      // below (unsupported), so it is a breadcrumb, not a Sentry event.
      context: { noSyncStatus: true, expectedErrorCodes: ['GRAPHQL_VALIDATION_FAILED'] },
    });
    return toPublicationProfile(data?.publicationProfile);
  } catch (err) {
    if (graphQLErrorCodes(err).includes('GRAPHQL_VALIDATION_FAILED')) {
      throw new PublicationProfileUnsupportedError();
    }
    throw err;
  }
}

export const defaultPublicationProfilePorts: PublicationProfilePorts = {
  fetch: fetchPublicationProfile,
  isOffline: () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { useNetworkStore } = require('@/lib/stores/network-store') as typeof import('@/lib/stores/network-store');
    return useNetworkStore.getState().isConnected === false;
  },
  onReconnect: (listener) => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { useNetworkStore } = require('@/lib/stores/network-store') as typeof import('@/lib/stores/network-store');
    return useNetworkStore.subscribe((s, prev) => {
      if (s.isConnected === true && prev.isConnected === false) listener();
    });
  },
};

/** Session flag: set by the first unsupported answer, never persisted. */
let unsupportedThisSession = false;

/** Test seam. */
export function __resetPublicationProfileSession(): void {
  unsupportedThisSession = false;
}

function isUnsupported(err: unknown): boolean {
  return !!err && typeof err === 'object' && (err as { unsupported?: unknown }).unsupported === true;
}

function keyParts(key: PublicationProfileKey | null | undefined): [string, string, string] {
  if (!key) return ['', '', ''];
  if ('publisherId' in key) return [key.publisherId ?? '', '', ''];
  return ['', (key.rawName ?? '').trim(), (key.countryCode ?? '').trim()];
}

/**
 * The hook factory, so tests can pass their own ports. The app uses
 * {@link usePublicationProfile}.
 */
export function makeUsePublicationProfile(ports: PublicationProfilePorts) {
  return function usePublicationProfileWith(
    key: PublicationProfileKey | null | undefined,
  ): PublicationProfileResult {
    const { i18n } = useTranslation();
    const appLanguage = i18n?.language ?? 'en';
    const [publisherId, rawName, countryCode] = keyParts(key);
    const [state, setState] = useState<PublicationProfileState>('loading');
    const [profile, setProfile] = useState<PublicationProfile | null>(null);
    const [attempt, setAttempt] = useState(0);
    const requestRef = useRef(0);

    useEffect(() => {
      const request = ++requestRef.current;
      const settle = (next: PublicationProfileState, value: PublicationProfile | null = null) => {
        if (requestRef.current !== request) return; // a newer key or retry owns the state
        setProfile(value);
        setState(next);
      };
      if (!publisherId && !rawName) {
        settle('notFound');
        return;
      }
      if (unsupportedThisSession) {
        settle('unsupported');
        return;
      }
      if (ports.isOffline()) {
        settle('offline');
        return;
      }
      setState('loading');
      const k: PublicationProfileKey = publisherId ? { publisherId } : { rawName, countryCode };
      ports
        .fetch(k, appLanguage)
        .then((p) => {
          if (p) rememberPublisherSourceNames(p.newsPublisherId, p.sourceNames);
          settle(p ? 'ready' : 'notFound', p);
        })
        .catch((err: unknown) => {
          if (isUnsupported(err)) {
            if (!unsupportedThisSession) {
              unsupportedThisSession = true;
              logger.info('[publication-profile] server has no publicationProfile; entry-point data this session');
            }
            settle('unsupported');
            return;
          }
          // The Apollo error link already reported it; the page shows the state.
          settle(ports.isOffline() ? 'offline' : 'error');
        });
    }, [publisherId, rawName, countryCode, appLanguage, attempt]);

    // Offline is left by itself when the link comes back.
    useEffect(() => {
      if (state !== 'offline') return;
      return ports.onReconnect(() => setAttempt((a) => a + 1));
    }, [state]);

    const retry = useCallback(() => setAttempt((a) => a + 1), []);
    return { state, profile, retry };
  };
}

/**
 * What the publication page knows about the publication it was opened for.
 * Pass `{ publisherId }` when the entry point has it, else
 * `{ rawName, countryCode }` exactly as the feed row carries them.
 */
export const usePublicationProfile = makeUsePublicationProfile(defaultPublicationProfilePorts);
