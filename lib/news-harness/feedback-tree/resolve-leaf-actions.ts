// resolveLeafActions — PURE, RN-FREE. Maps a leaf's ABSTRACT actions (with
// placeholders) to CONCRETE persona mutations using on-device context. The
// resulting `ResolvedPersonaAction[]` is structurally a `PersonaAction[]` and is
// handed straight to the Wave-9 `applyPersonaActions` dispatcher by the overlay.
//
// Forward-compat: an unknown `type`, or a placeholder whose context is missing,
// is SKIPPED (never throws) — the app simply applies the actions it can resolve.

import { ACTION_NAMES } from '../persona-management/action-names';
import type { SuppressionKindName } from '../core/types';
import { isDiscriminatingCategory } from './category-specificity';
import type {
  FeedbackTreeAbstractAction,
  FeedbackTreeLeaf,
  LocalFeedbackContext,
  ResolvedPersonaAction,
} from './types';

/**
 * `add_suppression` pattern placeholders → the context field they copy, plus the
 * suppression KIND that field legitimately backs.
 *
 * D9: a structured filter matches by exact normalized equality against ONE
 * article field, so its value must BE that field, verbatim. A placeholder is the
 * only thing that guarantees it — hence the kind is tied to the placeholder
 * rather than trusted from the leaf alone. `from_context_title` backs no kind: a
 * headline is not a matchable field, so a title-derived filter is always a
 * keyword one.
 */
const SUPPRESSION_SOURCES: Record<
  string,
  { read: (c: LocalFeedbackContext) => string | null | undefined; kind?: SuppressionKindName }
> = {
  from_context_title: { read: (c) => c.articleTitle },
  from_context_category: { read: (c) => c.category, kind: 'category' },
  from_context_eventType: { read: (c) => c.eventType, kind: 'event_type' },
};

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
      const source = typeof a.pattern === 'string' ? SUPPRESSION_SOURCES[a.pattern] : undefined;
      const pattern = source
        ? source.read(ctx)?.trim()
        : typeof a.pattern === 'string'
          ? a.pattern.trim()
          : undefined;
      if (!pattern) return [];
      // The kind rides along ONLY when the leaf asks for exactly the kind its
      // placeholder's field backs. A literal pattern, a mismatched kind or an
      // unknown one degrades to a keyword filter: matching fewer things is
      // fine, matching nothing while looking active is not.
      //
      // `category` carries one extra gate: ~74% of the source catalogue sits on
      // the generic "news" family, where an exact match means "most of the
      // feed" rather than "this category" (see category-specificity). A generic
      // value degrades to a keyword filter — silently, and behaving exactly as
      // it did before D10.
      const asked = source?.kind && a.kind === source.kind ? source.kind : undefined;
      const structuredKind =
        asked === 'category' && !isDiscriminatingCategory(pattern) ? undefined : asked;
      return [
        {
          action_type: ACTION_NAMES.ADD_SUPPRESSION,
          suppressionPattern: pattern,
          suppressionStrength: num(a.strength),
          ...(structuredKind
            ? { suppressionKind: structuredKind, suppressionValue: pattern }
            : {}),
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
