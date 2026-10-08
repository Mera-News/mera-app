// The ONE map from a pre-navx route to where it lives now. Used by the deep
// link rewrite (`app/+native-intent.tsx`), by the pending notification route
// (a tap stashed by the old bundle is read by the new one after the OTA
// reload) and anything else holding an old path.
//
// Page state never rides in the URL: a target names its tab route plus an
// optional `page` the caller hands to navigateToPage's one-shot pending store
// (components/custom/nav). `params` carries only what the destination route
// itself reads (`card` for Stats, the interest route's own params).
//
// Pure: no React, no router, no storage. Returns null for anything that is not
// an old route, so callers can pass every path through it.

import type { PageId } from './page-order';

export interface LegacyTarget {
  /** A current route path, e.g. `/logged-in/app_container/you`. */
  pathname: string;
  /** Sub-page to open inside that tab. */
  page?: PageId;
  params?: Record<string, string>;
}

const TABS = '/logged-in/app_container';

type Rule = (params: Record<string, string>) => LegacyTarget;

const pick = (params: Record<string, string>, keys: readonly string[]): Record<string, string> | undefined => {
  const out: Record<string, string> = {};
  for (const k of keys) if (params[k] !== undefined) out[k] = params[k];
  return Object.keys(out).length ? out : undefined;
};

const RULES: Readonly<Record<string, Rule>> = {
  // The four old tabs.
  [`${TABS}/for_you`]: () => ({ pathname: `${TABS}/feed` }),
  [`${TABS}/around`]: () => ({ pathname: `${TABS}/world` }),
  [`${TABS}/profile`]: () => ({ pathname: `${TABS}/you`, page: 'profile' }),
  [`${TABS}/settings`]: () => ({ pathname: `${TABS}/you`, page: 'settings' }),
  // The six root stubs.
  '/logged-in/share-stats': () => ({ pathname: `${TABS}/library`, page: 'stats' }),
  '/logged-in/saved-suggestions': () => ({ pathname: `${TABS}/library`, page: 'saved' }),
  '/logged-in/visited-publications': () => ({ pathname: `${TABS}/library`, page: 'visited' }),
  '/logged-in/profile-advanced': () => ({ pathname: `${TABS}/you`, page: 'profile' }),
  '/logged-in/config-panel': () => ({ pathname: `${TABS}/you`, page: 'profile' }),
  '/logged-in/fact-feed': (p) => ({
    pathname: `${TABS}/feed/interest`,
    params: pick(p, ['factId', 'statement', 'via']),
  }),
};

function parseQuery(query: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of query.split('&')) {
    if (!part) continue;
    const eq = part.indexOf('=');
    const rawKey = eq === -1 ? part : part.slice(0, eq);
    const rawValue = eq === -1 ? '' : part.slice(eq + 1);
    try {
      out[decodeURIComponent(rawKey)] = decodeURIComponent(rawValue.replace(/\+/g, ' '));
    } catch {
      // A malformed escape drops that one param, never the whole link.
    }
  }
  return out;
}

/**
 * Where an old route lives now, or null when `href` is not an old route.
 * Accepts a bare path (`/logged-in/share-stats?card=keep`), a path without its
 * leading slash, or a full deep link (`meraapp://logged-in/...`).
 */
export function normalizeLegacyHref(href: string): LegacyTarget | null {
  const [rawPath, ...rest] = href.trim().replace(/^[a-z][a-z0-9+.-]*:\/\//i, '').split('?');
  let path = rawPath.split('#')[0].replace(/\/+$/, '');
  if (!path.startsWith('/')) path = `/${path}`;
  const rule = RULES[path];
  if (!rule) return null;
  const target = rule(parseQuery(rest.join('?').split('#')[0]));
  if (!target.params) delete target.params;
  return target;
}
