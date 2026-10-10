import type { ProposalAction, StagedProposal, ToolCallRecord } from '@/lib/llm/types';
import { parseTrackScopeOptions } from '@/lib/news-harness/article-feedback/agent-core';
import { parseFactCheckClaimOptions } from '@/lib/news-harness/fact-check';
import {
  SUPPRESSION_KINDS,
  type SuppressionKindName,
} from '@/lib/news-harness/core/types';
import { resolveCountryScope } from '@/lib/news-harness/persona-management/persona-agent-core';
import { asRecord, toStringArray } from './derive-fact-cards';

// ---------------------------------------------------------------------------
// Proposal-card derivation
// ---------------------------------------------------------------------------
//
// The article-feedback agent stages persona changes via a `proposeChanges`
// tool call whose INPUT carries { explanation, expected_effects, actions[] }.
// We rebuild a StagedProposal defensively from that input so a persisted (and
// therefore resumed) proposal re-renders its confirm card. `applyProposal` /
// `cancelProposal` tool calls surface nothing — they only mutate store state.
//
// Proposal id reconciliation: the agent generates the StagedProposal id as its
// own nonce (executeTool never receives the tool-call id), so the tool-call id
// does NOT equal the store proposal id. If the tool RESULT echoes an id we use
// it (lets ProposalCard match store.proposal / resolvedProposals by id); else
// we fall back to the tool-call id as a stable card identity. ProposalCard's
// final pending/expired decision also uses "is this the LAST proposal card"
// so correctness never depends on the echo. See ProposalCard.tsx.

/**
 * Re-validate ONE persisted proposal action into a `ProposalAction`.
 *
 * This deliberately stays a SECOND parser rather than reusing the harness
 * sanitizer (`decideProposeChanges`/`validateAction`): that one is
 * context-sensitive — it corroborates a structured filter's value against the
 * live article context and resolves a `retire_suppression` id against the
 * filter list it rendered into <context>. Neither input exists on resume. What
 * we re-read here is already-sanitized output, so the job is a shape check, not
 * a sanitize.
 *
 * The cost of that split is real (it is exactly what silently dropped
 * structured filters and `retire_suppression` from every resumed card), so it
 * is EXPORTED and covered by the action-type coverage test that walks both
 * agents' tool enums.
 */
export function parseProposalAction(value: unknown): ProposalAction | null {
  const rec = asRecord(value);
  if (!rec) return null;
  const type = typeof rec.type === 'string' ? rec.type : '';
  switch (type) {
    case 'add_fact': {
      const statement = typeof rec.statement === 'string' ? rec.statement.trim() : '';
      return statement ? { type: 'add_fact', statement } : null;
    }
    case 'update_fact': {
      const factId = typeof rec.fact_id === 'string' ? rec.fact_id : '';
      const next = typeof rec.new_statement === 'string' ? rec.new_statement.trim() : '';
      return factId && next ? { type: 'update_fact', fact_id: factId, new_statement: next } : null;
    }
    case 'delete_fact': {
      const factId = typeof rec.fact_id === 'string' ? rec.fact_id : '';
      return factId ? { type: 'delete_fact', fact_id: factId } : null;
    }
    case 'add_topics': {
      const factId = typeof rec.fact_id === 'string' ? rec.fact_id : '';
      const topics = toStringArray(rec.topics);
      return factId && topics.length > 0 ? { type: 'add_topics', fact_id: factId, topics } : null;
    }
    case 'remove_topics': {
      const factId = typeof rec.fact_id === 'string' ? rec.fact_id : '';
      const topics = toStringArray(rec.topics);
      return factId && topics.length > 0
        ? { type: 'remove_topics', fact_id: factId, topics }
        : null;
    }
    case 'submit_feature_request': {
      const title = typeof rec.title === 'string' ? rec.title.trim() : '';
      const summary = typeof rec.summary === 'string' ? rec.summary.trim() : '';
      return title && summary ? { type: 'submit_feature_request', title, summary } : null;
    }
    // -- Wave-9 rails-backed actions (previously dropped on resume — the parser
    //    silently returned null, so a persisted feed-tuning proposal never
    //    re-rendered its confirm card). Mirror the harness validateAction shapes. --
    case 'set_topic_weight': {
      const topicText = typeof rec.topicText === 'string' ? rec.topicText.trim() : '';
      const delta = typeof rec.delta === 'number' && Number.isFinite(rec.delta) ? rec.delta : NaN;
      return topicText && Number.isFinite(delta) && delta !== 0
        ? { type: 'set_topic_weight', topicText, delta }
        : null;
    }
    case 'add_negative_topic': {
      const topicText = typeof rec.topicText === 'string' ? rec.topicText.trim() : '';
      if (!topicText) return null;
      return typeof rec.weight === 'number' && Number.isFinite(rec.weight)
        ? { type: 'add_negative_topic', topicText, weight: rec.weight }
        : { type: 'add_negative_topic', topicText };
    }
    case 'set_publication_pref': {
      const publicationId = typeof rec.publicationId === 'string' ? rec.publicationId.trim() : '';
      const pref = typeof rec.publicationPref === 'string' ? rec.publicationPref.trim() : '';
      return publicationId && (pref === 'boost' || pref === 'deprioritize' || pref === 'mute')
        ? { type: 'set_publication_pref', publicationId, publicationPref: pref }
        : null;
    }
    case 'set_source_scope_pref': {
      // source-pref v47 (D2/D6). The PERSISTED args carry what the model said
      // (`scopeCountry`, an English country NAME) — not the resolved token —
      // so the resume path has to redo the resolution the sanitizer did.
      // `resolveCountryScope` is the sanitizer's own helper, shared rather than
      // reimplemented: two copies of a closed-vocabulary mapping is exactly the
      // drift that makes a resumed card mean something different from the one
      // the user first saw. Unresolvable ⇒ null ⇒ the action is dropped, same
      // as at staging time.
      const resolved = resolveCountryScope(
        typeof rec.scopeCountry === 'string' ? rec.scopeCountry : '',
      );
      const pref = typeof rec.publicationPref === 'string' ? rec.publicationPref.trim() : '';
      // No `mute`: nothing implements a scope exclusion, so a mute is rejected
      // here exactly as the sanitizer and the executor reject it.
      return resolved && (pref === 'boost' || pref === 'deprioritize')
        ? {
            type: 'set_source_scope_pref',
            scopeKind: 'country',
            scopeValue: resolved.scopeValue,
            label: resolved.label,
            publicationPref: pref,
          }
        : null;
    }
    case 'add_suppression': {
      const pattern = typeof rec.suppressionPattern === 'string' ? rec.suppressionPattern.trim() : '';
      if (!pattern) return null;
      const keywords = toStringArray(rec.suppressionKeywords);
      const action: ProposalAction = { type: 'add_suppression', suppressionPattern: pattern };
      if (keywords.length > 0) action.suppressionKeywords = keywords;
      if (typeof rec.suppressionStrength === 'number' && Number.isFinite(rec.suppressionStrength)) {
        action.suppressionStrength = rec.suppressionStrength;
      }
      // Structured filter (D9): kind + value travel together or not at all — a
      // kind with no value matches NOTHING, so an incomplete pair degrades to
      // the keyword filter the pattern already describes.
      const kind =
        typeof rec.suppressionKind === 'string' ? rec.suppressionKind.trim().toLowerCase() : '';
      const value = typeof rec.suppressionValue === 'string' ? rec.suppressionValue.trim() : '';
      if (value && (SUPPRESSION_KINDS as readonly string[]).includes(kind)) {
        action.suppressionKind = kind as SuppressionKindName;
        action.suppressionValue = value;
      }
      return action;
    }
    case 'retire_suppression': {
      const suppressionId =
        typeof rec.suppressionId === 'string' ? rec.suppressionId.trim() : '';
      if (!suppressionId) return null;
      // `pattern` is resolved by the sanitizer from OUR filter list and is NOT
      // echoed into the persisted tool result, so a resumed card usually has
      // none. That costs a detail line — dropping the whole action (the old
      // behaviour) cost the entire card.
      const pattern = typeof rec.pattern === 'string' ? rec.pattern.trim() : '';
      return { type: 'retire_suppression', suppressionId, pattern };
    }
    case 'set_high_priority': {
      const topicText = typeof rec.topicText === 'string' ? rec.topicText.trim() : '';
      return topicText && typeof rec.highPriority === 'boolean'
        ? { type: 'set_high_priority', topicText, highPriority: rec.highPriority }
        : null;
    }
    case 'retire_topic': {
      const topicText = typeof rec.topicText === 'string' ? rec.topicText.trim() : '';
      return topicText ? { type: 'retire_topic', topicText } : null;
    }
    // No payload to validate — the action is its own instruction. Needed so a
    // RESUMED conversation still renders the card (and so its Confirm button
    // still works) after the popover was closed and reopened.
    case 'run_calibration':
      return { type: 'run_calibration' };
    default:
      return null;
  }
}

/** Rebuilds a StagedProposal from a completed `proposeChanges` tool call. */
export function deriveProposal(toolCall: ToolCallRecord): StagedProposal | null {
  if (toolCall.status !== 'done' || toolCall.name !== 'proposeChanges') return null;
  // A REFUSED proposal draws no card (ux2 batch 25, F7): the card was built
  // from the tool INPUT regardless, so a proposal the agent rejected
  // (`{ error }`) rendered already "no longer active" and nothing could be
  // added. Same class as chips for a refused ask_choice.
  if (typeof asRecord(toolCall.result)?.error === 'string') return null;

  const input = asRecord(toolCall.input) ?? {};
  const rawActions = Array.isArray(input.actions) ? input.actions : [];
  const actions: ProposalAction[] = [];
  for (const raw of rawActions) {
    const action = parseProposalAction(raw);
    if (action) actions.push(action);
  }
  // A proposal with no valid action is malformed — skip it entirely.
  if (actions.length === 0) return null;

  const explanation = typeof input.explanation === 'string' ? input.explanation.trim() : '';
  const expectedEffects =
    typeof input.expected_effects === 'string'
      ? input.expected_effects.trim()
      : typeof input.expectedEffects === 'string'
        ? input.expectedEffects.trim()
        : '';

  // Prefer an id echoed by the tool result; otherwise use the tool-call id.
  const result = asRecord(toolCall.result);
  const echoedId =
    typeof result?.id === 'string'
      ? result.id
      : typeof result?.proposalId === 'string'
        ? result.proposalId
        : null;

  // Single-select mode: recover from the tool INPUT (choose_one) with the RESULT
  // echo as a fallback. Only meaningful with ≥2 alternatives.
  const chooseOne =
    (input.choose_one === true || result?.chooseOne === true) && actions.length >= 2;

  return {
    id: echoedId ?? toolCall.id,
    explanation,
    expectedEffects,
    actions,
    ...(chooseOne ? { chooseOne: true } : {}),
  };
}

/**
 * Rebuilds a track StagedProposal from a completed `proposeTrack` tool call. The
 * tool INPUT carries the scope `options` (label + hidden search); the confirmable
 * origin `subject` and the parsed options are echoed in the RESULT (see
 * decideProposeTrack), so we recover the full `track_story` actions from input +
 * result via the same parser the live path uses. On resume without a result the
 * card still renders (dimmed, no confirm) from the options alone.
 */
export function deriveTrackProposal(toolCall: ToolCallRecord): StagedProposal | null {
  if (toolCall.status !== 'done' || toolCall.name !== 'proposeTrack') return null;

  const input = asRecord(toolCall.input) ?? {};
  const result = asRecord(toolCall.result);

  // Subject is only load-bearing on Confirm (live session, result present). A
  // resumed card is dimmed, so an empty subject is harmless there.
  const subjectRec = asRecord(result?.subject);
  const subject = {
    origin: (subjectRec?.origin === 'article' ? 'article' : 'suggestion') as
      | 'article'
      | 'suggestion',
    surface: typeof subjectRec?.surface === 'string' ? subjectRec.surface : 'detail',
    articleId: typeof subjectRec?.articleId === 'string' ? subjectRec.articleId : '',
    title: typeof subjectRec?.title === 'string' ? subjectRec.title : '',
    stableClusterId:
      typeof subjectRec?.stableClusterId === 'string' ? subjectRec.stableClusterId : null,
    publicationName:
      typeof subjectRec?.publicationName === 'string' ? subjectRec.publicationName : null,
    ...(typeof subjectRec?.pubDate === 'string' ? { pubDate: subjectRec.pubDate } : {}),
  };

  // Rebuild the scope pills from input.options (result.options as fallback), or a
  // legacy `track` string. Same parser as the live path → identical actions.
  const rawOptions =
    (Array.isArray(input.options) && input.options) ||
    (Array.isArray(result?.options) && result.options) ||
    (typeof input.track === 'string' && input.track.trim() ? [input.track] : []) ||
    [];
  const options = parseTrackScopeOptions(rawOptions);
  if (options.length === 0) return null;

  const echoedId = typeof result?.proposalId === 'string' ? result.proposalId : null;
  const actions: ProposalAction[] = options.map((o) => ({
    type: 'track_story',
    label: o.label,
    searchText: o.search,
    subject,
  }));
  return {
    id: echoedId ?? toolCall.id,
    explanation: '',
    expectedEffects: '',
    actions,
    ...(actions.length >= 2 ? { chooseOne: true } : {}),
  };
}

/**
 * Rebuilds a fact-check StagedProposal from a completed `proposeFactCheck` tool
 * call. Structurally identical to `deriveTrackProposal`: the tool INPUT carries
 * the claim `options` (label + searchable claim); the confirmable article
 * `subject` and the parsed options are echoed in the RESULT (see
 * decideProposeFactCheck), so we recover the full `fact_check_claim` actions
 * from input + result through the SAME parser the live path uses — a resumed
 * thread therefore rebuilds byte-identical actions. On resume without a result
 * the card still renders (dimmed, no confirm) from the options alone.
 */
export function deriveFactCheckProposal(toolCall: ToolCallRecord): StagedProposal | null {
  if (toolCall.status !== 'done' || toolCall.name !== 'proposeFactCheck') return null;

  const input = asRecord(toolCall.input) ?? {};
  const result = asRecord(toolCall.result);

  // Subject is only load-bearing on Confirm (live session, result present). A
  // resumed card is dimmed, so an empty subject is harmless there — and
  // `enqueueFactCheck` would be handed an empty articleId rather than a wrong
  // one, which the executor's own empty-claim guard cannot mask.
  const subjectRec = asRecord(result?.subject);
  const subject = {
    surface: typeof subjectRec?.surface === 'string' ? subjectRec.surface : 'fact-check-chat',
    articleId: typeof subjectRec?.articleId === 'string' ? subjectRec.articleId : '',
    articleTitle: typeof subjectRec?.articleTitle === 'string' ? subjectRec.articleTitle : '',
    ...(typeof subjectRec?.articleUrl === 'string' ? { articleUrl: subjectRec.articleUrl } : {}),
    ...(typeof subjectRec?.publicationName === 'string'
      ? { publicationName: subjectRec.publicationName }
      : {}),
  };

  // Rebuild the claim pills from input.options (result.options as fallback), or
  // a legacy lone `claim` string. Same parser as the live path → identical
  // actions.
  // RESULT FIRST, unlike the track card above. The staged options are a superset
  // of the model's: decideProposeFactCheck appends the whole-article pill, and
  // reading `input.options` in preference would rebuild a card missing it.
  const rawOptions =
    (Array.isArray(result?.options) && result.options) ||
    (Array.isArray(input.options) && input.options) ||
    (typeof input.claim === 'string' && input.claim.trim() ? [input.claim] : []) ||
    [];
  const options = parseFactCheckClaimOptions(rawOptions);
  if (options.length === 0) return null;

  const echoedId = typeof result?.proposalId === 'string' ? result.proposalId : null;
  const actions: ProposalAction[] = options.map((o) => ({
    type: 'fact_check_claim',
    label: o.label,
    claim: o.claim,
    subject,
    // The trailing whole-article pill. It only ever reaches this parser via
    // `result.options` (the model never emits it and the tool INPUT never
    // carries it), which is exactly why decideProposeFactCheck echoes the
    // options it staged rather than only the ones it was given — without that
    // echo a resumed card would silently lose the thorough path.
    ...(o.mode === 'article' ? { mode: 'article' as const } : {}),
  }));
  return {
    id: echoedId ?? toolCall.id,
    explanation: '',
    expectedEffects: '',
    actions,
    ...(actions.length >= 2 ? { chooseOne: true } : {}),
  };
}
