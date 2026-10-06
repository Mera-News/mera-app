// Mera button hint rotation: which hint of a page's pool shows this app
// session. One per session, the next one next session, looping.
//
// Storage: one `settings` row, `nav_hint_cursor`, a JSON map of POOL key to
// the index the NEXT session shows. A pool key, not a page id: World and every
// country page share one pool, so the map never grows with countries.
//
// Invariant 9 (no behavioural instrumentation): the stored value is
// `(i + 1) % poolLength`, never an increment, so it is bounded by the pool and
// cannot count how often a page was opened. It operates the rotation and
// records nothing about reading. Local only: never sent anywhere, and on the
// backup FORBIDDEN list (lib/backup/allowlist.ts).
//
// "Session" is this JS context: the first call per pool advances the row, every
// later call in the same context returns the same index. No memory mirror of
// the row (it would outlive the settings wipe on an account switch); writes are
// serialised through one promise chain because each one rewrites the whole map.

import logger from '@/lib/logger';

export const HINT_CURSOR_SETTING_KEY = 'nav_hint_cursor';

const taken = new Map<string, Promise<number>>();
let chain: Promise<unknown> = Promise.resolve();

function settings(): typeof import('@/lib/database/services/setting-service') {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require('@/lib/database/services/setting-service');
}

function parseMap(raw: string | null): Record<string, number> {
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const out: Record<string, number> = {};
    for (const [k, v] of Object.entries(parsed)) {
      if (Number.isInteger(v) && (v as number) >= 0) out[k] = v as number;
    }
    return out;
  } catch {
    return {};
  }
}

async function advance(poolKey: string, poolLength: number): Promise<number> {
  const { getSetting, setSetting } = settings();
  const map = parseMap(await getSetting(HINT_CURSOR_SETTING_KEY));
  const index = (map[poolKey] ?? 0) % poolLength;
  map[poolKey] = (index + 1) % poolLength;
  await setSetting(HINT_CURSOR_SETTING_KEY, JSON.stringify(map));
  return index;
}

/**
 * The hint index to show for `poolKey` this session, in `[0, poolLength)`.
 * Stable within a JS context; advances the stored cursor once per context.
 * Never rejects (a storage failure shows the first hint).
 */
export function takeHintIndex(poolKey: string, poolLength: number): Promise<number> {
  if (!Number.isInteger(poolLength) || poolLength <= 0) return Promise.resolve(0);
  let result = taken.get(poolKey);
  if (!result) {
    const run = chain.then(() => advance(poolKey, poolLength));
    chain = run.catch(() => undefined);
    result = run.catch((err: unknown) => {
      logger.captureException(err, { tags: { module: 'hint-cursor', method: 'takeHintIndex' } });
      return 0;
    });
    taken.set(poolKey, result);
  }
  // A pool can shrink within a session (web-search hints drop out while that
  // setting is off), so clamp the memoised index to the current length.
  return result.then((i) => i % poolLength);
}
