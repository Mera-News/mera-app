// resolveLeafActions — PURE, RN-FREE. Maps a leaf's ABSTRACT actions (with
// placeholders) to CONCRETE persona mutations using on-device context. The
// resulting `ResolvedPersonaAction[]` is structurally a `PersonaAction[]` and is
// handed straight to the Wave-9 `applyPersonaActions` dispatcher by the overlay.
//
// Forward-compat: an unknown `type`, or a placeholder whose context is missing,
// is SKIPPED (never throws) — the app simply applies the actions it can resolve.

import { ACTION_NAMES } from '../persona-management/action-names';
import type {
  FeedbackTreeAbstractAction,
  FeedbackTreeLeaf,
  LocalFeedbackContext,
  ResolvedPersonaAction,
} from './types';

/** Numeric passthrough — undefined when the field isn't a finite number. */
function num(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

/** Distinct, non-null topic ids selected by a `set_topic_weight` scope. */
function pickTopicIds(scope: string | undefined, ctx: LocalFeedbackContext): string[] {
  const matchedIds = (ctx.matchedTopics ?? [])
    .map((t) => t.topicId)
    .filter((id): id is string => !!id);

  let ids: string[];
  if (scope === 'from_selection') {
    // Explicit selection when present; otherwise fall back to all matched.
    ids = ctx.selectedTopicIds && ctx.selectedTopicIds.length > 0
      ? ctx.selectedTopicIds
      : matchedIds;
  } else {
    // 'matched' (or any other scope) → all matched topic ids.
    ids = matchedIds;
  }
  return Array.from(new Set(ids.filter((id) => !!id)));
}

function resolveOne(
  a: FeedbackTreeAbstractAction,
  ctx: LocalFeedbackContext,
): ResolvedPersonaAction[] {
  switch (a.type) {
    case 'set_publication_pref': {
      const pub = ctx.publicationName?.trim();
      if (!pub) return [];
      if (a.value !== 'deprioritize' && a.value !== 'mute' && a.value !== 'boost') return [];
      return [
        {
          action_type: ACTION_NAMES.SET_PUBLICATION_PREF,
          publicationId: pub, // publication NAME — the app keys publications by name
          publicationPref: a.value,
        },
      ];
    }

    case 'add_negative_topic': {
      const text =
        a.text === 'from_context_geo'
          ? ctx.geoText?.trim()
          : typeof a.text === 'string'
            ? a.text.trim()
            : undefined;
      if (!text) return [];
      return [
        {
          action_type: ACTION_NAMES.ADD_NEGATIVE_TOPIC,
          topicText: text,
          weight: num(a.weight),
        },
      ];
    }

    case 'set_topic_weight': {
      const ids = pickTopicIds(a.topics, ctx);
      if (ids.length === 0) return [];
      const delta = num(a.delta);
      return ids.map((topicId) => ({
        action_type: ACTION_NAMES.SET_TOPIC_WEIGHT,
        topicId,
        delta,
      }));
    }

    case 'add_suppression': {
      const pattern =
        a.pattern === 'from_context_title'
          ? ctx.articleTitle?.trim()
          : a.pattern === 'from_context_category'
            ? ctx.category?.trim()
            : a.pattern === 'from_context_eventType'
              ? ctx.eventType?.trim()
              : typeof a.pattern === 'string'
                ? a.pattern.trim()
                : undefined;
      if (!pattern) return [];
      return [
        {
          action_type: ACTION_NAMES.ADD_SUPPRESSION,
          suppressionPattern: pattern,
          suppressionStrength: num(a.strength),
        },
      ];
    }

    default:
      // Unknown action type — server may ship nodes a stale app can't apply.
      return [];
  }
}

/**
 * Resolve a leaf's abstract `actions` into concrete persona mutations. Nudge /
 * openChat / seenOnly leaves carry no `actions` and resolve to `[]` — the
 * overlay handles those flavors directly.
 */
export function resolveLeafActions(
  leaf: FeedbackTreeLeaf | undefined,
  ctx: LocalFeedbackContext,
): ResolvedPersonaAction[] {
  if (!leaf?.actions?.length) return [];
  const out: ResolvedPersonaAction[] = [];
  for (const a of leaf.actions) {
    out.push(...resolveOne(a, ctx));
  }
  return out;
}
