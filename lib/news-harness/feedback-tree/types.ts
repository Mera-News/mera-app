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
import type { SuppressionKindName } from '../core/types';

/** visibleIf gate keys understood by this app schema. Server may add more — an
 *  unknown key is IGNORED (does not hide the node) for forward-compat. */
export interface FeedbackTreeCondition {
  publication_visits_gte?: number;
  cluster_size_gte?: number;
  has_matched_topics?: boolean;
  has_geo_mismatch?: boolean;
  /** True ⇒ the node is hidden unless the article carries an `eventType`.
   *
   *  MEASURED 2026-08-10 over 300 topic-linked prod articles: `event_type` is
   *  present on **97%** of SERVED articles (entities 70%, geo_tags 85%). The
   *  older claim in this comment — "ZERO of ~303k articles" — was true when the
   *  gate was written and is now stale: it measured the RAW corpus (~8%), which
   *  is not what a feedback tree ever sees, and it predates the 2026-07-30 and
   *  2026-08-09 enrichment backfills. The gate stays because 3% is not 0%: on
   *  those articles the leaf resolves to no actions, applies nothing and shows
   *  no toast, and a dead option is worse than a missing one. */
  has_event_type?: boolean;
  /** True ⇒ the node is hidden unless the article carries at least one
   *  `entity`. Same rationale as `has_event_type`, at a lower coverage —
   *  entities are present on ~70% of served articles, so ~30% of taps would
   *  land on a chip that does nothing without this. `isInertActionLeaf` is the
   *  belt to this gate's braces (it hides any action leaf that resolves empty
   *  whatever the server tree says), which matters because an UNKNOWN gate key
   *  is ignored rather than enforced — a typo here fails OPEN. */
  has_entity?: boolean;
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
  /** add_suppression → a SUPPRESSION_KINDS name, promoting the filter from a
   *  keyword substring scan to an exact match on one article field (D9). Only
   *  honoured when `pattern` is the context placeholder that reads THAT field —
   *  see resolve-leaf-actions. Anything else stays a keyword filter. */
  kind?: string;
  weight?: number;
  delta?: number;
  strength?: number;
  [key: string]: unknown;
}

/** The closed set of HOST INTENTS a `nudge` leaf can carry. Exported so every
 *  surface that forwards one spells it the same way — the union used to be
 *  re-typed inline in five components, and widening it meant finding all five. */
export type FeedbackNudge = 'subscribe' | 'browse_related' | 'manage_publication';

/** Terminal node payload. Exactly one flavor is meaningful per leaf. */
export interface FeedbackTreeLeaf {
  /** Concrete persona mutations (resolved from `actions` + local context). */
  actions?: FeedbackTreeAbstractAction[];
  /** A SUGGESTION (not a mutation): a HOST INTENT the surface acts on instead
   *  of applying anything to the persona. `browse_related` opens the story's
   *  related coverage; `manage_publication` opens the publication-preferences
   *  screen (the app's only boost/downrank/mute control); `subscribe` is legacy
   *  — no current tree authors it and every host ignores it. */
  nudge?: FeedbackNudge;
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
  /** v4 — an optional per-node MESSAGE rendered with the option, explaining what
   *  picking it does or why it is being offered. Resolved exactly like the label
   *  (`t(descKey, { defaultValue: descDefault })`) and interpolated from LOCAL
   *  context only: `{{publication}}` ← publicationName, `{{visits}}` ←
   *  publicationVisits. Deliberately NOT `{{count}}` — i18next reserves that var
   *  to select `_one`/`_other` plural suffixes on the key itself, which would
   *  404 to `descDefault` on every locale shipping only the base key. */
  descKey?: string;
  descDefault?: string;
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
  /** Human-readable place label for `from_context_geo` and for `{{place}}` in a
   *  label — the most specific nameable place across the article's geo tags,
   *  with a SUPRANATIONAL code rendered as prose ("MIDDLE_EAST" → "Middle
   *  East"). Display text, and the search string a negative topic is built
   *  from. NOT the token a `place` filter compares against — see `placeValue`. */
  geoText?: string | null;
  /** The VERBATIM geo-tag field `geoText` was derived from (the tag's own
   *  `city` / `region` / `countryCode`, uncooked) — the source for
   *  `from_context_place`.
   *
   *  Separate from `geoText` because a structured `place` filter matches by
   *  exact normalized equality against a geo-tag field, so its value must BE
   *  that field. `geoText` is not: it resolves a supranational code to prose,
   *  and `normCountry` only trims/uppercases, so a filter built from "Middle
   *  East" would compare "MIDDLE EAST" against the tag's "MIDDLE_EAST" and
   *  match nothing, forever, while looking perfectly applied. */
  placeValue?: string | null;
  /** Category label for `from_context_category` (e.g. "Politics"). */
  category?: string | null;
  /** Event-type label for `from_context_eventType` (e.g. "Earnings call"). */
  eventType?: string | null;
  /** The article's PRIMARY entity (server emits entities most-central-first) —
   *  source for `from_context_entity` and for `{{entity}}` in a label. Singular
   *  on purpose: one value means the label and the action it mints can never
   *  name different things. */
  entity?: string | null;
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
  /** D9 structured filter — set together, and only when `suppressionValue` is
   *  the article's own field value copied verbatim (see resolve-leaf-actions). */
  suppressionKind?: SuppressionKindName;
  suppressionValue?: string;
}
