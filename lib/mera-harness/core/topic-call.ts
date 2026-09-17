// mera-harness/core — the background topic call. PURE, RN-free.
//
// TERMINAL: one call per accepted fact, nothing follows it. The whole system
// prompt is the composed topic guideline for the fact kind chosen UPSTREAM by
// the chat turn; the fact, the other facts and the exclusions go in the user
// message. The model returns a list and the job ends.
//
// No fact-only/combo split, no two halves to re-key, no merge step: the
// cross-product decision lives in the guideline's own section.

import { loadSkill as defaultLoadSkill } from './skill-loader';
import { escapeUntrusted } from './state-line';
import { filterNearDuplicates, type DedupeDrop } from './topic-dedupe';
import type { AgentModelResult, PlaceChain } from './types';

/** The only cap. There is NO per-persona ceiling. */
export const MAX_TOPICS_PER_FACT = 12;

/** Output budget. Thinking is OFF, so no reasoning headroom is added: measured,
 *  thinking ON returned EMPTY content on 8 of 10 probes at 8-10s because a
 *  ~2000-token trace ate the budget for a ~55-token answer, against 0.8-1.0s
 *  and a valid answer every time with it off. 12 topics plus JSON is ~140
 *  tokens, so 400 is comfortable. Do not re-enable thinking without a fresh
 *  A/B. */
export const TOPIC_CALL_MAX_TOKENS = 400;
export const TOPIC_CALL_TEMPERATURE = 0.3;

export interface TopicCallFact {
  statement: string;
  questionnaireAttribute?: string | null;
  placeChain?: PlaceChain | null;
}

export interface GenerateTopicsParams {
  fact: TopicCallFact;
  /** The skill id chosen upstream, e.g. `topics/residence`. Absent or unknown
   *  falls back to the group generic, never to a failure: inference_jobs is
   *  durable, so a job enqueued before an OTA outlives the build that named
   *  its skill. */
  skillId?: string;
  otherFacts?: string[];
  /** The persona's ACTIVE topic texts, read at RUN time by the caller. */
  existingTopics?: string[];
  /** Declined texts, read at RUN time by the caller. */
  declinedTopics?: string[];
  deps: {
    callModel: (req: {
      role: 'topicgen';
      model: string;
      systemPrompt: string;
      messages: { role: 'user'; content: string }[];
      temperature: number;
      maxTokens: number;
      enableThinking: false;
    }) => Promise<AgentModelResult>;
    loadSkill?: (id: string) => string | null;
  };
  model?: string;
  ceiling?: number;
  /** Absent means ON. An arm passes 'off' to measure without the filter. */
  dedupe?: 'off' | 'overlap';
}

export interface GenerateTopicsOutcome {
  topics: string[];
  result: AgentModelResult;
  /** Makes "done with zero" answerable: the model returned nothing, or the
   *  declined veto removed everything, or the filter did. Without the split,
   *  the one mechanism that silently produces "it stopped learning about me"
   *  is indistinguishable from a bad prompt. */
  dropped: { veto: number; filter: number };
  filterDrops: DedupeDrop[];
}

const FALLBACK_SKILL = 'topics/generic';

export function normalizeTopicText(s: string): string {
  return s.toLowerCase().trim().replace(/\s+/g, ' ');
}

export function buildTopicUserMessage(p: GenerateTopicsParams): string {
  const lines: string[] = [`Fact: "${escapeUntrusted(p.fact.statement, 400)}"`];
  if (p.fact.questionnaireAttribute) {
    lines.push(`Attribute: ${escapeUntrusted(p.fact.questionnaireAttribute, 120)}`);
  }
  const others = (p.otherFacts ?? []).filter(Boolean);
  if (others.length > 0) {
    lines.push(`Other user facts:\n${others.map((s) => `- ${escapeUntrusted(s, 300)}`).join('\n')}`);
  }
  // Existing AND declined go into the SAME exclusion block: to the model they
  // are one instruction, "do not produce these".
  const exclusions = [...(p.existingTopics ?? []), ...(p.declinedTopics ?? [])].filter(Boolean);
  if (exclusions.length > 0) {
    lines.push(
      `Do NOT repeat these existing topics:\n${exclusions
        .map((s) => `- ${escapeUntrusted(s, 200)}`)
        .join('\n')}`,
    );
  }
  lines.push(`Generate at most ${p.ceiling ?? MAX_TOPICS_PER_FACT} topics — fewer is correct.`);
  return lines.join('\n');
}

export function parseTopics(output: string): string[] {
  const attempt = (text: string): string[] | null => {
    try {
      const parsed: unknown = JSON.parse(text);
      if (!Array.isArray(parsed)) return null;
      return parsed
        .filter((x): x is string => typeof x === 'string' && x.trim().length > 0)
        .map((s) => s.trim());
    } catch {
      return null;
    }
  };
  return attempt(output) ?? attempt(output.match(/\[[\s\S]*?\]/)?.[0] ?? '') ?? [];
}

/**
 * One terminal call.
 *
 * TWO LAYERS on declined topics, and only the second one holds. Putting a text
 * in the prompt is a REQUEST: shown an exclude list, a model still returns an
 * existing topic with a scope word bolted on. The veto below is the guarantee —
 * declined texts are matched on normalised form and dropped before the caller
 * ever sees them, because the database is advisory and does not refuse them.
 */
export async function generateTopicsForFact(
  params: GenerateTopicsParams,
): Promise<GenerateTopicsOutcome> {
  const ceiling = params.ceiling ?? MAX_TOPICS_PER_FACT;
  const loadSkillFn = params.deps.loadSkill ?? defaultLoadSkill;
  const systemPrompt =
    (params.skillId ? loadSkillFn(params.skillId) : null) ?? loadSkillFn(FALLBACK_SKILL) ?? '';

  const result = await params.deps.callModel({
    role: 'topicgen',
    model: params.model ?? 'SMALL',
    systemPrompt,
    messages: [{ role: 'user', content: buildTopicUserMessage({ ...params, ceiling }) }],
    temperature: TOPIC_CALL_TEMPERATURE,
    maxTokens: TOPIC_CALL_MAX_TOKENS,
    enableThinking: false,
  });

  const raw = parseTopics(result.content);

  const declined = new Set((params.declinedTopics ?? []).map(normalizeTopicText));
  const kept: string[] = [];
  let vetoed = 0;
  for (const t of raw) {
    if (declined.has(normalizeTopicText(t))) {
      vetoed++;
      continue;
    }
    kept.push(t);
  }

  const deduped =
    params.dedupe === 'off'
      ? { kept, dropped: [] as DedupeDrop[] }
      : filterNearDuplicates(kept);

  return {
    topics: deduped.kept.slice(0, ceiling),
    result,
    dropped: { veto: vetoed, filter: deduped.dropped.length },
    filterDrops: deduped.dropped,
  };
}
