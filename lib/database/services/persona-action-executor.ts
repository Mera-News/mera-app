// Persona-Action Executor — the single dispatch point for ALL deterministic
// persona mutations (Wave 9). The feedback-tree overlay leaves AND the feedback
// agent's proposals both route through `applyPersonaAction`: it maps each
// `action_type` to the right WatermelonDB service, and every mutation appends
// exactly one invertible `persona_change_log` row (so `revertChange` can undo
// it). No mutation math lives here — the arithmetic is in the pure rails; this
// is glue over the per-collection services + mutation-rails adapter.
//
// Contract: never throws (callers batch). Unsupported/incomplete actions return
// `{ applied: false, summary }` instead of raising. Nudge SUGGESTIONS
// (`nudge_subscribe_publication` / `nudge_browse_related`) are NOT persona
// mutations — they return `{ applied: false }` and write NO change-log row (the
// UI surfaces the nudge).

import * as topicService from './topic-service';
import * as suppressionService from './suppression-service';
import * as locationService from './location-service';
import * as publicationPreferenceService from './publication-preference-service';
import * as changeLogService from './persona-change-log-service';
import * as mutationRailsService from './mutation-rails-service';
import logger from '../../logger';
import { ACTION_NAMES } from '../../news-harness/persona-management/action-names';
import type { ActionName } from '../../news-harness/persona-management/action-names';
import type { PersonaChangeLogSource } from '../models/PersonaChangeLog';
import type { PublicationPreferenceProvenance } from '../models/PublicationPreference';
import { SUPPRESSION_KINDS } from '../models/PersonaSuppression';
import type { PersonaSuppressionKind } from '../models/PersonaSuppression';
import {
  markFeedNeedsRefresh,
  runSweepFor,
  sweepForMutation,
} from './persona-mutation-sweeps';

/** Default weight for a minted NEGATIVE topic when the action omits one. */
const DEFAULT_NEGATIVE_TOPIC_WEIGHT = -0.6;
/** Default weight for a minted POSITIVE topic (explicit interest) when omitted. */
const DEFAULT_POSITIVE_TOPIC_WEIGHT = 0.5;
/** Default strength for a minted suppression (soft — score penalty) when omitted. */
const DEFAULT_SUPPRESSION_STRENGTH = 0.5;

export interface PersonaAction {
  action_type: ActionName;
  topicId?: string;
  topicText?: string; // add_topic / add_negative_topic (mint)
  factId?: string;
  locationId?: string;
  publicationId?: string;
  publicationPref?: 'boost' | 'deprioritize' | 'mute'; // set_publication_pref
  weight?: number; // absolute weight where the type sets one
  delta?: number; // nudge delta where the type nudges
  highPriority?: boolean; // set_high_priority
  suppressionPattern?: string; // add_suppression
  suppressionKeywords?: string[];
  suppressionStrength?: number;
  /** retire_suppression — the `persona_suppressions` row id to retire. */
  suppressionId?: string;
  /** add_suppression — what the filter matches (v46 structured kinds). Typed
   *  `string`, not the union, on purpose: proposals reach here from an LLM, so
   *  the value is validated against SUPPRESSION_KINDS at dispatch and anything
   *  unrecognised degrades to `undefined` (⇒ NULL column ⇒ reads as 'keyword'). */
  suppressionKind?: string;
  /** add_suppression — the single token the non-keyword kinds compare against. */
  suppressionValue?: string;
}

export interface ApplyActionResult {
  applied: boolean;
  changeLogId?: string;
  summary: string;
}

/** Internal-only dispatch result. `purged` is not part of the public contract —
 *  it just tells the seam whether an immediate hard-filter purge already
 *  reconciled the feed, so the D18 dirty-marking can be skipped. */
interface DispatchResult extends ApplyActionResult {
  purged?: boolean;
}

/** Short 2-dp weight label for summaries (English only). */
function fmt(w: number): string {
  return w.toFixed(2);
}

/** Known action, but missing/invalid fields → skipped (never thrown). */
function skipped(action: PersonaAction, reason: string): ApplyActionResult {
  return { applied: false, summary: `skipped ${action.action_type}: ${reason}` };
}

/** Map a change-log source to the publication-preference provenance enum. */
function pubProvenanceFor(source: PersonaChangeLogSource): PublicationPreferenceProvenance {
  if (source === 'user') return 'user';
  if (source === 'migration') return 'migration';
  return 'feedback';
}

/**
 * Validate an incoming suppression kind against the v46 vocabulary. Unknown /
 * absent ⇒ `undefined`, which the service stores as a NULL `kind` column and
 * `kindOf` reads back as 'keyword' — the historical behaviour. A bogus kind must
 * degrade to a keyword filter, never persist a value nothing will ever match.
 */
function normalizeSuppressionKind(
  raw: string | undefined,
  value: string | undefined,
): PersonaSuppressionKind | undefined {
  if (!raw) return undefined;
  if (!(SUPPRESSION_KINDS as readonly string[]).includes(raw)) return undefined;
  const kind = raw as PersonaSuppressionKind;
  // Same guard, second failure mode: every STRUCTURED kind compares against
  // `value` by exact normalized equality, and the matcher treats an absent
  // value as "matches nothing" (deliberately — never "matches everything").
  // Persisting a valueless structured kind would therefore store a filter that
  // looks active and does nothing, which is precisely what this validation
  // exists to prevent. Degrade to keyword so the row still matches on its
  // keywords / human pattern. Reachable: proposals arrive from an LLM.
  if (kind !== 'keyword' && !value) return undefined;
  return kind;
}

/**
 * D18. A persona change means the feed is stale. This executor is the single
 * choke point every FORWARD mutation flows through (feedback leaves, chat
 * proposals, plan accepts, the filter actions) — before this, only the
 * persona-EDITING screens set the flag, so a persona changed via feedback or
 * chat produced no refresh hint at all.
 *
 * `revertChange` is the OTHER mutation path; it applies the same rule via the
 * same shared module, which is why the sweep policy lives there and not here.
 */

/**
 * Single dispatch point for ALL deterministic persona mutations (feedback tree
 * leaves + feedback agent proposals). Routes each action_type to the right
 * service, and every mutation appends an invertible persona_change_log row.
 */
export async function applyPersonaAction(
  action: PersonaAction,
  source: PersonaChangeLogSource,
): Promise<ApplyActionResult> {
  try {
    const { purged, ...result } = await dispatch(action, source);
    // D18. Mark the feed stale for anything that actually landed. Gating on
    // `applied` excludes nudges/skips/unsupported without a per-case list.
    //
    // Asymmetry, deliberate: a PURGE already ran an immediate refreshUi and the
    // excluded rows are gone from the screen, so there is nothing to re-derive —
    // dirtying is for changes that need a RESCORE. An UN-exclude is the other
    // way round: it resets rows to `unscored`, which only the next scoring pass
    // can resolve, so it does mark the feed dirty (it is not flagged `purged`).
    if (result.applied && !purged) markFeedNeedsRefresh();
    return result;
  } catch (error) {
    logger.captureException(error, {
      tags: { service: 'persona-action-executor', action_type: action.action_type },
    });
    return { applied: false, summary: `error applying ${action.action_type}` };
  }
}

/** Convenience: apply a list, best-effort, returning per-action results. */
export async function applyPersonaActions(
  actions: PersonaAction[],
  source: PersonaChangeLogSource,
): Promise<ApplyActionResult[]> {
  const results: ApplyActionResult[] = [];
  for (const action of actions) {
    // applyPersonaAction never throws — one bad action can't abort the batch.
    results.push(await applyPersonaAction(action, source));
  }
  return results;
}

async function dispatch(
  action: PersonaAction,
  source: PersonaChangeLogSource,
): Promise<DispatchResult> {
  switch (action.action_type) {
    // -- Topic weight -------------------------------------------------------
    case ACTION_NAMES.SET_TOPIC_WEIGHT: {
      if (!action.topicId) return skipped(action, 'missing topicId');
      if (typeof action.delta === 'number') {
        // Budget-leashed nudge (mutation-rails owns the append + budget).
        const r = await mutationRailsService.nudgeTopic(action.topicId, action.delta, source);
        return {
          applied: r.applied,
          summary: r.applied
            ? `Nudged topic weight to ${fmt(r.after)}`
            : 'Nudge budget exhausted; topic weight unchanged',
        };
      }
      if (typeof action.weight === 'number') {
        const r = await mutationRailsService.setTopicWeightAbsolute(
          action.topicId,
          action.weight,
          source,
        );
        return {
          applied: r.applied,
          changeLogId: r.changeLogId,
          summary: r.applied
            ? `Set topic weight to ${fmt(r.after)}`
            : 'Topic weight unchanged',
        };
      }
      return skipped(action, 'no delta or weight');
    }

    // -- Topic high-priority pin -------------------------------------------
    case ACTION_NAMES.SET_HIGH_PRIORITY: {
      if (!action.topicId) return skipped(action, 'missing topicId');
      if (typeof action.highPriority !== 'boolean') return skipped(action, 'missing highPriority');
      await mutationRailsService.setTopicHighPriority(action.topicId, action.highPriority, source);
      return {
        applied: true,
        summary: action.highPriority ? 'Pinned topic as high priority' : 'Unpinned topic',
      };
    }

    // -- Fact weight nudge --------------------------------------------------
    case ACTION_NAMES.SET_FACT_WEIGHT: {
      if (!action.factId) return skipped(action, 'missing factId');
      if (typeof action.delta !== 'number') return skipped(action, 'missing delta');
      await mutationRailsService.nudgeFactWeight(action.factId, action.delta, source);
      return { applied: true, summary: 'Adjusted fact weight' };
    }

    // -- Mint a NEGATIVE topic ---------------------------------------------
    case ACTION_NAMES.ADD_NEGATIVE_TOPIC: {
      const text = action.topicText?.trim();
      if (!text) return skipped(action, 'missing topicText');
      const weight = typeof action.weight === 'number' ? action.weight : DEFAULT_NEGATIVE_TOPIC_WEIGHT;
      const [created] = await topicService.createTopics([
        { text, weight, status: 'active', provenance: 'feedback' },
      ]);
      if (!created) return { applied: false, summary: 'failed to create negative topic' };
      const row = await changeLogService.append({
        actionType: ACTION_NAMES.ADD_NEGATIVE_TOPIC,
        action: { targetId: created.id, text },
        source,
        summary: `Added negative topic: ${text}`,
      });
      return { applied: true, changeLogId: row.id, summary: `Added negative topic: ${text}` };
    }

    // -- Mint a POSITIVE topic ---------------------------------------------
    case ACTION_NAMES.ADD_TOPIC: {
      const text = action.topicText?.trim();
      if (!text) return skipped(action, 'missing topicText');
      const weight = typeof action.weight === 'number' ? action.weight : DEFAULT_POSITIVE_TOPIC_WEIGHT;
      const [created] = await topicService.createTopics([
        { text, weight, status: 'active', provenance: 'feedback' },
      ]);
      if (!created) return { applied: false, summary: 'failed to create topic' };
      const row = await changeLogService.append({
        actionType: ACTION_NAMES.ADD_TOPIC,
        action: { targetId: created.id, text },
        source,
        summary: `Added topic: ${text}`,
      });
      return { applied: true, changeLogId: row.id, summary: `Added topic: ${text}` };
    }

    // -- Retire a topic -----------------------------------------------------
    case ACTION_NAMES.RETIRE_TOPIC: {
      if (!action.topicId) return skipped(action, 'missing topicId');
      await topicService.retire(action.topicId);
      const row = await changeLogService.append({
        actionType: ACTION_NAMES.RETIRE_TOPIC,
        action: { targetId: action.topicId },
        source,
        summary: 'Retired topic',
      });
      return { applied: true, changeLogId: row.id, summary: 'Retired topic' };
    }

    // -- Mint a suppression -------------------------------------------------
    case ACTION_NAMES.ADD_SUPPRESSION: {
      const pattern = action.suppressionPattern?.trim();
      if (!pattern) return skipped(action, 'missing suppressionPattern');
      const strength =
        typeof action.suppressionStrength === 'number'
          ? action.suppressionStrength
          : DEFAULT_SUPPRESSION_STRENGTH;
      const value = action.suppressionValue?.trim() || undefined;
      const kind = normalizeSuppressionKind(action.suppressionKind, value);
      const suppression = await suppressionService.addSuppression({
        pattern,
        keywords: action.suppressionKeywords ?? [],
        strength,
        // Was hardcoded 'feedback', which mislabelled every filter the user
        // created by hand. The suppression `source` enum has no 'chat'/'digest'
        // → 'feedback' equivalents worth splitting here, so: user means user,
        // everything else is feedback.
        source: source === 'user' ? 'user' : 'feedback',
        kind,
        value,
      });
      const row = await changeLogService.append({
        actionType: ACTION_NAMES.ADD_SUPPRESSION,
        action: { targetId: suppression.id, kind, value },
        source,
        summary: `Suppressed: ${pattern}`,
      });
      // D12a. Hard filters are retroactive — screen what is ALREADY stored.
      // Soft suppressions are a score penalty, so they wait for the next pass.
      // Compare the strength WE clamped/defaulted, not the persisted row's:
      // the decision is about the action, and it must not depend on the shape
      // the service happens to return.
      const purged = await runSweepFor(
        sweepForMutation({
          actionType: action.action_type,
          hardFilter: strength >= suppressionService.HARD_SUPPRESSION_STRENGTH,
        }),
        action.action_type,
      );
      return { applied: true, changeLogId: row.id, summary: `Suppressed: ${pattern}`, purged };
    }

    // -- Remove a suppression (audited, invertible) -------------------------
    case ACTION_NAMES.RETIRE_SUPPRESSION: {
      const suppressionId = action.suppressionId;
      if (!suppressionId) return skipped(action, 'missing suppressionId');
      // Load the row BEFORE retiring it. Two reasons, both load-bearing: the
      // change-log summary has to name the pattern (a bare id is useless in the
      // audit list), and the row's strength is what decides whether the
      // un-exclude sweep runs. The service exposes no getById, so this mirrors
      // SET_LOCATION_WEIGHT's getAll + find.
      const all = await suppressionService.getAll();
      const existing = all.find((s) => s.id === suppressionId);
      if (!existing) return { applied: false, summary: 'suppression not found' };
      const wasHard = existing.strength >= suppressionService.HARD_SUPPRESSION_STRENGTH;
      const kind = suppressionService.kindOf(existing);
      const pattern = existing.pattern;

      await suppressionService.retireSuppression(suppressionId);
      const row = await changeLogService.append({
        actionType: ACTION_NAMES.RETIRE_SUPPRESSION,
        action: { targetId: suppressionId, pattern, kind },
        source,
        summary: `Removed filter: ${pattern}`,
      });
      // D12c. Retiring a HARD filter gives its casualties a second chance. Rows
      // a still-active filter also matches stay excluded (the sweep re-screens
      // against the live persona, so the two-filters-on-one-row case is free).
      // runSweepFor returns false for an un-exclude — the released rows come
      // back `unscored` and need the next scoring pass, so the feed IS dirty.
      const purged = await runSweepFor(
        sweepForMutation({ actionType: action.action_type, hardFilter: wasHard }),
        action.action_type,
      );
      return {
        applied: true,
        changeLogId: row.id,
        summary: `Removed filter: ${pattern}`,
        purged,
      };
    }

    // -- Location weight ----------------------------------------------------
    case ACTION_NAMES.SET_LOCATION_WEIGHT: {
      if (!action.locationId) return skipped(action, 'missing locationId');
      if (typeof action.weight !== 'number') return skipped(action, 'missing weight');
      const all = await locationService.getAll();
      const loc = all.find((l) => l.id === action.locationId);
      if (!loc) return { applied: false, summary: 'location not found' };
      const before = loc.weight;
      const after = Math.max(0, Math.min(1, action.weight)); // location weights ∈ [0,1]
      await locationService.setWeight(action.locationId, after);
      const row = await changeLogService.append({
        actionType: ACTION_NAMES.SET_LOCATION_WEIGHT,
        action: { targetId: action.locationId, before, after },
        source,
        summary: `Adjusted location weight ${fmt(before)} → ${fmt(after)}`,
      });
      return { applied: true, changeLogId: row.id, summary: 'Adjusted location weight' };
    }

    // -- Publication preference (NEW Wave 9 executor) -----------------------
    case ACTION_NAMES.SET_PUBLICATION_PREF: {
      if (!action.publicationId) return skipped(action, 'missing publicationId');
      if (!action.publicationPref) return skipped(action, 'missing publicationPref');
      const before = await publicationPreferenceService.getPreferenceKind(action.publicationId);
      await publicationPreferenceService.setPreferenceKind(
        action.publicationId,
        action.publicationPref,
        pubProvenanceFor(source),
      );
      const row = await changeLogService.append({
        actionType: ACTION_NAMES.SET_PUBLICATION_PREF,
        action: { targetId: action.publicationId, before, after: action.publicationPref },
        source,
        summary: `Set publication preference: ${action.publicationId} → ${action.publicationPref}`,
      });
      // D12b. A mute (weight ≤ -0.9) IS a hard `kind:'publication'` filter — it
      // is synthesized as one when the scoring context loads, so both sweeps
      // see it live with no extra plumbing here. Muting purges retroactively;
      // raising the weight back above -0.9 (unmute, incl. switching to
      // boost/deprioritize/none) releases what the mute had excluded.
      const purged = await runSweepFor(
        sweepForMutation({
          actionType: action.action_type,
          prefBefore: before,
          prefAfter: action.publicationPref,
        }),
        action.action_type,
      );
      return {
        applied: true,
        changeLogId: row.id,
        summary: `Set publication preference: ${action.publicationId} → ${action.publicationPref}`,
        purged,
      };
    }

    // -- Nudges are SUGGESTIONS, not mutations — no change-log row ----------
    case ACTION_NAMES.NUDGE_SUBSCRIBE_PUBLICATION: {
      return {
        applied: false,
        summary: `Suggestion: subscribe to ${action.publicationId ?? 'publication'}`,
      };
    }
    case ACTION_NAMES.NUDGE_BROWSE_RELATED: {
      return {
        applied: false,
        summary: `Suggestion: browse related to ${action.topicText ?? action.topicId ?? 'topic'}`,
      };
    }

    default:
      return { applied: false, summary: `unsupported: ${action.action_type}` };
  }
}
