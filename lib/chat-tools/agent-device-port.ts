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
} from '@/lib/mera-harness';
import { loadSkill, skillIds } from '@/lib/mera-harness';
import { findSimilarFacts } from '../database/services/fact-similarity-service';
import { lookupPlace } from '../place-service';
import { cloudChatStream, type WireMessage } from '../llm/cloudComplete';
import { BIG_MODEL, CHAT_MAX_OUTPUT_TOKENS } from '../llm/constants';
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
    lookupPlace(args: LookupPlaceArgs): Promise<LookupPlaceResult> {
      return lookupPlace(args.query, args.countryHint);
    },
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
export async function callModelViaCloud(req: AgentModelRequest): Promise<AgentModelResult> {
  const started = Date.now();
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
    toolChoice: 'auto',
    model: req.model || BIG_MODEL,
    maxTokens: req.maxTokens ?? CHAT_MAX_OUTPUT_TOKENS,
    // Thinking OFF on every agent call. Measured: the trace buys nothing here
    // and costs the whole budget on the topic path.
    enableThinking: req.enableThinking ?? false,
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
    modelSent: req.model || BIG_MODEL,
    latencyMs: Date.now() - started,
    ttVisibleMs,
    error: null,
  };
}

export function makeAgentDeps(
  userMessage: string,
  onDelta: (d: { content?: string; reasoning?: string }) => void,
): AgentDeps {
  return {
    callModel: (req) => callModelViaCloud({ ...req, onDelta }),
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
