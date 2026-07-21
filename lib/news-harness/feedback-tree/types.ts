// Feedback-tree types — PURE, RN-FREE (no lib/database, lib/stores, expo,
// react-native, watermelondb, zustand). The server OWNS the tree content
// (fetched + version-checked + cached with a bundled fallback); the app
// validates and resolves it. These types mirror the server's `feedback_tree_v1`
// shape: a node is a branch (`children`) OR a leaf (`leaf`); abstract leaf
// actions carry placeholders the app fills from local (on-device) context.
//
// v2 adds `likeRoot` — a second, sibling tree for the LIKE side of the new
// verdict bar ("More like this" / "Less like this"). Same node/leaf shape as
// `root` (the dislike tree); leaves lean positive (boost values, positive
// deltas) instead of negative.

import type { ActionName } from '../persona-management/action-names';

/** visibleIf gate keys understood by this app schema. Server may add more — an
 *  unknown key is IGNORED (does not hide the node) for forward-compat. */
export interface FeedbackTreeCondition {
  publication_visits_gte?: number;
  cluster_size_gte?: number;
  has_matched_topics?: boolean;
  has_geo_mismatch?: boolean;
  // Forward-compat: server may add gate keys this app doesn't know.
  [key: string]: unknown;
}

/**
 * One abstract action on a leaf. `type` matches a persona `action_type`
 * (`set_publication_pref` / `add_negative_topic` / `set_topic_weight` /
 * `add_suppression`). Placeholder-valued fields (`value` literals, `text:
 * 'from_context_geo'`, `topics: 'from_selection'|'matched'`, `pattern:
 * 'from_context_title'`) are filled from LOCAL context by `resolveLeafActions`.
 * An unknown `type` is IGNORED (forward-compat: the server may ship nodes a
 * stale app doesn't understand).
 */
export interface FeedbackTreeAbstractAction {
  type: string;
  /** set_publication_pref → 'deprioritize' | 'mute' | 'boost' */
  value?: string;
  /** add_negative_topic → 'from_context_geo' or a literal topic text (weight
   *  may be positive on the like-tree, e.g. a place-boost leaf) */
  text?: string;
  /** set_topic_weight → 'from_selection' | 'matched' */
  topics?: string;
  /** add_suppression → 'from_context_title' | 'from_context_category' |
   *  'from_context_eventType', or a literal pattern */
  pattern?: string;
  weight?: number;
  delta?: number;
  strength?: number;
  [key: string]: unknown;
}

/** Terminal node payload. Exactly one flavor is meaningful per leaf. */
export interface FeedbackTreeLeaf {
  /** Concrete persona mutations (resolved from `actions` + local context). */
  actions?: FeedbackTreeAbstractAction[];
  /** A SUGGESTION (not a mutation): surface a subscribe / browse-related nudge. */
  nudge?: 'subscribe' | 'browse_related';
  /** Escalate INTO the Mera chat instead of applying a mutation. */
  openChat?: boolean;
  /** Destructive — the UI must confirm before applying (e.g. mute-publication). */
  confirm?: boolean;
  /** "I've seen this" — acknowledge only; no persona mutation. */
  seenOnly?: boolean;
}

/** A tree node: a branch (`children`) OR a leaf (`leaf`). */
export interface FeedbackTreeNode {
  id: string;
  labelKey: string;
  labelDefault: string;
  icon?: string;
  visibleIf?: FeedbackTreeCondition;
  children?: FeedbackTreeNode[];
  leaf?: FeedbackTreeLeaf;
}

export interface FeedbackTree {
  version: number;
  root: FeedbackTreeNode[];
  /** v2: the LIKE-side tree for the verdict bar's "More like this". Optional
   *  for forward/backward-compat — a tree seeded before v2 (or a stale cached
   *  payload) simply has no like options. */
  likeRoot?: FeedbackTreeNode[];
}

/**
 * On-device context used to (a) gate node visibility and (b) fill the abstract
 * leaf-action placeholders. All fields optional — a missing field simply gates
 * out nodes / skips actions that depend on it (graceful degradation).
 */
export interface LocalFeedbackContext {
  /** Publication NAME — the app keys publications by name (no separate id). */
  publicationName?: string | null;
  countryCode?: string | null;
  /** Title of the disliked article — source for `from_context_title`. */
  articleTitle?: string | null;
  /** Geo label for `from_context_geo` (e.g. the article's place/region). */
  geoText?: string | null;
  /** Category label for `from_context_category` (e.g. "Politics"). */
  category?: string | null;
  /** Event-type label for `from_context_eventType` (e.g. "Earnings call"). */
  eventType?: string | null;
  /** Topics the suggestion matched (topicId null for synthetic headline hits). */
  matchedTopics?: { topicId: string | null; text: string }[];
  /** Explicitly-selected subset for `from_selection` (else falls back to all matched). */
  selectedTopicIds?: string[];
  /** Story-cluster size (visibleIf cluster_size_gte). */
  clusterSize?: number;
  /** Local visit count for this publication (visibleIf publication_visits_gte). */
  publicationVisits?: number;
  /** Whether the article's geo mismatches the user's (visibleIf has_geo_mismatch). */
  hasGeoMismatch?: boolean;
}

/**
 * A concrete persona mutation produced by `resolveLeafActions`. Structurally a
 * subset of the RN `PersonaAction` (persona-action-executor) so it can be passed
 * straight to `applyPersonaActions` — declared here (RN-free) to keep this module
 * pure. `action_type` reuses the canonical `ActionName` ids.
 */
export interface ResolvedPersonaAction {
  action_type: ActionName;
  topicId?: string;
  topicText?: string;
  publicationId?: string;
  publicationPref?: 'boost' | 'deprioritize' | 'mute';
  weight?: number;
  delta?: number;
  suppressionPattern?: string;
  suppressionKeywords?: string[];
  suppressionStrength?: number;
}
