// agent-device-port — the app's implementation of the harness's AgentToolPort
// and AgentDeps.
//
// This is the seam the whole design rests on: the SAME `runAgentTurn` runs in
// the app and in the eval, so a harness green is evidence about the app rather
// than about a parallel implementation. Everything device-shaped lives here;
// nothing in lib/mera-harness knows this file exists.

import type {
  AgentDeps,
  AgentModelRequest,
  AgentModelResult,
  AgentToolPort,
  FindSimilarFactsArgs,
  FindSimilarFactsResult,
  LookupPlaceArgs,
  LookupPlaceResult,
  Place,
} from '@/lib/mera-harness';
import { loadSkill, skillIds } from '@/lib/mera-harness';
import { findSimilarFacts } from '../database/services/fact-similarity-service';
import { lookupPlace } from '../place-service';
import { cloudChatStream, type WireMessage } from '../llm/cloudComplete';
import type { PhaseSignal } from '@/lib/services/chat-phase';
import { BIG_MODEL, CHAT_MAX_OUTPUT_TOKENS, SMALL_MODEL } from '../llm/constants';
import { handleDeleteUserFacts, handleSaveExtractedFacts } from './tool-handlers';
import { getFacts } from '../database/services/fact-service';
import type { AgentPersona } from '@/lib/mera-harness';
import logger from '../logger';

const TAG = '[AgentPort]';

/**
 * `statement` comes from the DEVICE, never from the model.
 *
 * The tool takes only an optional `kind` precisely so the user's words stay out
 * of a cleartext tool argument; the raw turn text is supplied here, on-device,
 * where it never leaves the phone.
 */
/**
 * The query forms to try, most specific first.
 *
 * `placeSearch` is an anchored PREFIX match over a GeoNames-seeded collection,
 * so a whole phrase like "Nieuw-West Amsterdam" matches nothing: no row begins
 * with it. On device that surfaced as "I'm having trouble verifying that
 * neighbourhood" and a prose question instead of the chips, even though both
 * "Amsterdam" and "Nieuw-West" resolve on their own.
 *
 * Order matters and is deliberate:
 *  1. the whole query, so an exact single-token place still wins outright;
 *  2. comma or space segments FROM THE END, because a place phrase runs
 *     narrow-to-wide ("Nieuw-West, Amsterdam") and the widest tail is the one
 *     a prefix index actually holds;
 *  3. any hyphenated token, which is the neighbourhood form GeoNames does
 *     carry ("Nieuw-West") and which segment 2 would otherwise skip past.
 *
 * Deterministic and deduped, so the same input always tries the same forms in
 * the same order.
 */
export function placeQueryForms(query: string): string[] {
  const raw = query.trim();
  if (!raw) return [];
  const forms: string[] = [raw];

  const segments = raw
    .split(/[,]/)
    .map((p) => p.trim())
    .filter(Boolean);
  // Narrow to wide, so the widest tail is tried before the narrowest head.
  for (let i = segments.length - 1; i >= 0; i--) forms.push(segments[i]);

  const words = raw.split(/\s+/).filter(Boolean);
  for (let i = words.length - 1; i >= 0; i--) forms.push(words[i]);

  for (const w of words) if (w.includes('-')) forms.push(w);

  const seen = new Set<string>();
  return forms.filter((f) => {
    const k = f.toLowerCase();
    if (!f || k.length < 2 || seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/**
 * An EXACT name match is not ambiguous with the prefix matches beside it.
 *
 * `placeSearch` is an anchored prefix match, so the fallback form "Amsterdam"
 * returns Amsterdam, Amsterdam-Zuidoost and Nieuw-Amsterdam. Handing all three
 * back reads as genuine ambiguity, and the agent asks "which Amsterdam?" with
 * options the user never said: measured on device from "I live in Nieuw-West
 * Amsterdam", where Nieuw-West is a NEIGHBOURHOOD of Amsterdam and the right
 * answer is one place plus a neighbourhood, not a question.
 *
 * So when exactly one candidate's locality equals the form, that one wins
 * outright. Two candidates with the same name stay ambiguous, which is the
 * case the choice chips exist for (Newcastle upon Tyne / under Lyme).
 */
export function narrowToExact(places: Place[], form: string): Place[] {
  if (places.length < 2) return places;
  const wanted = form.trim().toLowerCase();
  const exact = places.filter((p) => p.locality.trim().toLowerCase() === wanted);
  return exact.length === 1 ? exact : places;
}

/**
 * Try each form and return the FIRST non-empty ranked result, recording which
 * form matched.
 *
 * `unavailable` short-circuits: the lookup FAILED, and retrying a narrower
 * form would turn a transport failure into a confident "no such place".
 */
export async function lookupPlaceWithFallback(
  args: LookupPlaceArgs,
): Promise<LookupPlaceResult> {
  const forms = placeQueryForms(args.query);
  let last: LookupPlaceResult = { status: 'no_match', query: args.query };

  for (const form of forms) {
    const out = await lookupPlace(form, args.countryHint);
    if (out.status === 'unavailable') return out;
    if (out.status === 'resolved' && out.places.length > 0) {
      if (form !== args.query) {
        logger.debug(`${TAG} place resolved on a fallback form`, {
          asked: args.query,
          matched: form,
        });
      }
      return { ...out, places: narrowToExact(out.places, form) };
    }
    if (out.status !== 'too_short') last = out;
  }
  return last;
}

export function makeAgentToolPort(userMessage: string): AgentToolPort {
  return {
    async findSimilarFacts(args: FindSimilarFactsArgs): Promise<FindSimilarFactsResult> {
      const rows = await findSimilarFacts(args.kind ?? null, userMessage, args.limit ?? 5);
      return {
        candidates: rows.map((r) => ({
          factId: r.id,
          statement: r.statement,
          attribute: r.questionnaireAttribute ?? null,
          overlap: r.score,
        })),
      };
    },
    lookupPlace: (args: LookupPlaceArgs) => lookupPlaceWithFallback(args),
    saveExtractedFacts(args) {
      return handleSaveExtractedFacts(args);
    },
    deleteUserFacts(args) {
      return handleDeleteUserFacts(args as unknown as Record<string, unknown>);
    },
  };
}

/**
 * Adapts `cloudChatStream` to the harness's `callModel`.
 *
 * Streaming is preserved through `onDelta`: the harness returns a whole result,
 * but the bubble has to fill token by token and the thinking caption has to
 * fire on the reasoning event, so deltas are forwarded as they arrive and the
 * aggregate is returned at the end.
 *
 * THROWS PROPAGATE. The harness only captures a RESOLVED error into the leg; a
 * thrown one must end the turn, which is what the hook's own catch expects.
 */
/**
 * Turn the core's TIER LABEL into a real model id.
 *
 * The core is RN-free and must never know a model id, so it emits 'BIG' /
 * 'SMALL'. The adapter is the only place that knows what those mean.
 *
 * This was `req.model || BIG_MODEL`, which looks like a fallback and is not:
 * 'BIG' is truthy, so the tier word went on the wire and NEAR answered
 * `503 Provider error: Model 'BIG' not found`. An unrecognised value is
 * treated as a tier miss and resolved to BIG rather than forwarded, because a
 * literal id would already have matched one of the two constants and anything
 * else is a bug that must not reach the provider.
 */
export function resolveTierToModelId(tier: string | undefined): string {
  if (tier === SMALL_MODEL || tier === BIG_MODEL) return tier;
  if (tier === 'SMALL') return SMALL_MODEL;
  if (tier === 'BIG' || !tier) return BIG_MODEL;
  logger.warn(`${TAG} unrecognised model tier, defaulting to BIG`, { tier });
  return BIG_MODEL;
}

/**
 * `onPhase` is a SECOND PARAMETER, not a field on `AgentModelRequest`.
 *
 * That type lives in `lib/mera-harness/core/types.ts`, and the harness may not
 * import anything outside itself. Threading the wait line's signal through it
 * would either drag `PhaseSignal` across the boundary `boundary.test.ts`
 * guards or duplicate the union there. The loop has no interest in the phase
 * either way: it is transport progress, not agent state.
 */
export async function callModelViaCloud(
  req: AgentModelRequest,
  onPhase?: (signal: PhaseSignal) => void,
): Promise<AgentModelResult> {
  const started = Date.now();
  const modelId = resolveTierToModelId(req.model);
  let ttVisibleMs: number | null = null;
  let content = '';
  const byIndex = new Map<number, { name: string; args: string }>();

  const messages: WireMessage[] = [
    { role: 'system', content: req.systemPrompt },
    ...req.messages.map((m) =>
      m.role === 'tool'
        ? ({ role: 'user', content: m.content } as WireMessage)
        : ({ role: m.role, content: m.content } as WireMessage),
    ),
  ];

  const stream = cloudChatStream({
    messages,
    tools: req.tools as never,
    toolChoice: req.toolChoice ?? 'auto',
    model: modelId,
    maxTokens: req.maxTokens ?? CHAT_MAX_OUTPUT_TOKENS,
    // Thinking OFF on every agent call. Measured: the trace buys nothing here
    // and costs the whole budget on the topic path.
    enableThinking: req.enableThinking ?? false,
    onPhase,
  });

  let finishReason = 'stop';
  for await (const event of stream) {
    if (event.type === 'reasoning') {
      req.onDelta?.({ reasoning: '' });
    } else if (event.type === 'text-delta') {
      if (ttVisibleMs === null) ttVisibleMs = Date.now() - started;
      content += event.delta;
      req.onDelta?.({ content: event.delta });
    } else if (event.type === 'tool-call-delta') {
      const slot = byIndex.get(event.index) ?? { name: '', args: '' };
      if (event.name) slot.name = event.name;
      slot.args += event.argumentsDelta;
      byIndex.set(event.index, slot);
    } else if (event.type === 'finish') {
      finishReason = event.reason;
    } else if (event.type === 'error') {
      throw new Error(event.message);
    }
  }

  return {
    content,
    toolCalls: [...byIndex.values()]
      .filter((c) => c.name)
      .map((c) => ({ name: c.name, argumentsRaw: c.args })),
    finishReason,
    truncated: finishReason === 'length',
    usage: null,
    modelSent: modelId,
    latencyMs: Date.now() - started,
    ttVisibleMs,
    error: null,
  };
}

export function makeAgentDeps(
  userMessage: string,
  onDelta: (d: { content?: string; reasoning?: string }) => void,
  onPhase?: (signal: PhaseSignal) => void,
): AgentDeps {
  return {
    callModel: (req) => callModelViaCloud({ ...req, onDelta }, onPhase),
    tools: makeAgentToolPort(userMessage),
    loadSkill,
    skillIds,
    now: () => Date.now(),
  };
}

export function logAgentTurn(reason: string, unknownTools: string[]): void {
  if (unknownTools.length > 0) {
    logger.warn(`${TAG} model invented tool names`, { unknownTools });
  }
  if (reason !== 'settled' && reason !== 'awaiting-user') {
    logger.warn(`${TAG} turn ended abnormally`, { reason });
  }
}


/**
 * The persona the loop reasons over, read fresh EVERY turn.
 *
 * Never cached across turns: the facts table is the authority, and a cached
 * copy would let the model be told it still holds a fact the user just
 * deleted.
 */
export async function buildAgentPersona(
  agentId: string,
  languageName?: string,
): Promise<AgentPersona> {
  const facts = await getFacts();
  return {
    // `getFacts()` is created_at DESC, and the harness keeps the FIRST n, so
    // the cap drops the OLDEST rather than the newest. Taking the last n here
    // once sent a heavy persona the 22 facts it had least recently created.
    facts: facts.map((f) => ({
      id: f.id,
      statement: f.statement,
      attribute: f.questionnaireAttribute ?? null,
    })),
    surface: agentId.endsWith('ONBOARDING') ? 'ONBOARDING' : 'CONFIG',
    languageName,
  };
}

/** The persona agent is the only one the loop drives; the article-feedback and
 *  tutorial agents keep their own single-shot flow. */
export function isPersonaAgent(agentId: string): boolean {
  return agentId.startsWith('persona-');
}
