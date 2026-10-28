// Feedback-tree service (RN) — fetch + version-check + cache the SERVER-OWNED
// feedback tree, with a bundled offline fallback.
//
// Read path (`getFeedbackTree`): in-memory memo → the NEWEST of the persisted
// cache (setting-service KV) and the bundled snapshot. A cached tree is a
// candidate only if it was built for schema MIN_ELIGIBLE_SCHEMA..APP_FEEDBACK_SCHEMA
// (a cache stored without `feedback_tree.min_schema` counts as older), and on a
// version tie the cached/served tree wins. Always resolves fast to SOME tree so
// the overlay never blocks on the network.
//
// Refresh path (`refreshFeedbackTree`): throttled (~24h). Sends the cached
// version as `currentVersion`; the server replies with treeJson "" (not-
// modified) when it matches. A response requiring a newer `minAppSchema` than
// this app is DROPPED (keep the cached/bundled tree). Offline / errors are
// swallowed — the cache/bundle already covers it.

import { gql } from '@apollo/client';
import client from '../apollo-client';
import { getSetting, setSetting } from '../database/services/setting-service';
import logger from '../logger';
import {
  APP_FEEDBACK_SCHEMA,
  BUNDLED_FEEDBACK_TREE,
} from '../algorithms/feedback-tree-snapshot';
import type { FeedbackTree, FeedbackTreeNode } from '../news-harness/feedback-tree/types';

const KEY_JSON = 'feedback_tree.json';
const KEY_VERSION = 'feedback_tree.version';
const KEY_FETCHED_AT = 'feedback_tree.fetched_at';
const KEY_MIN_SCHEMA = 'feedback_tree.min_schema';

/** Trees built for an older schema lose to the bundled tree (existing devices' cached v4/v5). */
const MIN_ELIGIBLE_SCHEMA = 6;
const schemaEligible = (minAppSchema: unknown): boolean =>
  typeof minAppSchema === 'number' &&
  minAppSchema >= MIN_ELIGIBLE_SCHEMA &&
  minAppSchema <= APP_FEEDBACK_SCHEMA;

/** Re-check the server at most once per this interval (unless `force`). */
const REFRESH_INTERVAL_MS = 24 * 60 * 60 * 1000;

const FEEDBACK_TREE_QUERY = gql`
  query FeedbackTree($currentVersion: Int) {
    feedbackTree(currentVersion: $currentVersion) {
      version
      minAppSchema
      updatedAt
      treeJson
    }
  }
`;

interface FeedbackTreeQueryResult {
  feedbackTree: {
    version: number;
    minAppSchema: number;
    updatedAt: string;
    treeJson: string;
  } | null;
}

// In-memory memo so repeated overlay opens don't re-hit WatermelonDB.
let memo: FeedbackTree | null = null;

/** Shallow structural validation — enough to trust a parsed tree to render. */
function validateTree(value: unknown): FeedbackTree | null {
  if (!value || typeof value !== 'object') return null;
  const t = value as { version?: unknown; root?: unknown };
  if (typeof t.version !== 'number' || !Array.isArray(t.root)) return null;
  const okNode = (n: unknown): n is FeedbackTreeNode =>
    !!n && typeof n === 'object' && typeof (n as FeedbackTreeNode).id === 'string';
  if (!t.root.every(okNode)) return null;
  return value as FeedbackTree;
}

/** Highest version wins; a tie goes to the served/cached tree. */
const newest = (served: FeedbackTree): FeedbackTree =>
  served.version >= BUNDLED_FEEDBACK_TREE.version ? served : BUNDLED_FEEDBACK_TREE;

/**
 * Best tree available RIGHT NOW: memo → newest of persisted cache and bundled
 * snapshot. Never throws; always returns a usable tree.
 */
export async function getFeedbackTree(): Promise<FeedbackTree> {
  if (memo) return memo;
  try {
    const json = await getSetting(KEY_JSON);
    if (json) {
      const parsed = validateTree(JSON.parse(json));
      if (parsed && schemaEligible(Number(await getSetting(KEY_MIN_SCHEMA)))) {
        memo = newest(parsed);
        return memo;
      }
    }
  } catch (err) {
    logger.captureException(err, {
      tags: { service: 'feedback-tree-service', method: 'getFeedbackTree.cache' },
    });
  }
  memo = BUNDLED_FEEDBACK_TREE;
  return memo;
}

/**
 * Re-check the server and refresh the cache. Throttled to `REFRESH_INTERVAL_MS`
 * unless `force`. Safe to fire-and-forget on overlay open / app start — offline
 * and error paths are swallowed (the cache/bundle already covers rendering).
 */
export async function refreshFeedbackTree(opts?: { force?: boolean }): Promise<void> {
  try {
    if (!opts?.force) {
      const fetchedAt = await getSetting(KEY_FETCHED_AT);
      if (fetchedAt && Date.now() - Number(fetchedAt) < REFRESH_INTERVAL_MS) return;
    }

    // An ineligible cache must not answer "not modified" for a tree we would not use.
    const cachedVersionStr = await getSetting(KEY_VERSION);
    const cachedEligible = schemaEligible(Number(await getSetting(KEY_MIN_SCHEMA)));
    const currentVersion = cachedVersionStr != null && cachedEligible ? Number(cachedVersionStr) : null;

    const { data } = await client.query<FeedbackTreeQueryResult>({
      query: FEEDBACK_TREE_QUERY,
      variables: { currentVersion: Number.isFinite(currentVersion) ? currentVersion : null },
      fetchPolicy: 'no-cache',
    });

    // Throttle regardless of outcome so we don't hammer the server.
    await setSetting(KEY_FETCHED_AT, String(Date.now()));

    const resp = data?.feedbackTree;
    if (!resp) return; // unseeded → keep bundled/cached
    if (resp.treeJson === '') return; // not-modified → nothing to do
    if (!schemaEligible(resp.minAppSchema)) {
      // Built for a newer app than this one, or for an older schema — keep the cached/bundled tree.
      logger.info?.(
        `[feedback-tree] server tree minAppSchema=${resp.minAppSchema} outside ${MIN_ELIGIBLE_SCHEMA}..${APP_FEEDBACK_SCHEMA}; keeping cached/bundled`,
      );
      return;
    }

    const parsed = validateTree(JSON.parse(resp.treeJson));
    if (!parsed) return;

    await setSetting(KEY_JSON, resp.treeJson);
    await setSetting(KEY_VERSION, String(resp.version));
    await setSetting(KEY_MIN_SCHEMA, String(resp.minAppSchema));
    memo = newest(parsed);
  } catch (err) {
    // Offline / parse / network — the cache or bundle already serves the UI.
    logger.captureException(err, {
      tags: { service: 'feedback-tree-service', method: 'refreshFeedbackTree' },
    });
  }
}

/** Test/reset hook — drop the in-memory memo. */
export function resetFeedbackTreeMemo(): void {
  memo = null;
}
