// mera-harness/core — the background topic call. PURE, RN-free.
//
// TERMINAL: one call per fact, nothing follows it. The whole system prompt is
// the composed topic guideline for the fact kind chosen UPSTREAM by the chat
// turn (or derived from the fact's attribute); the fact and the exclusions go
// in the user message. The model returns a list and the job ends.
//
// ISOLATED (owner design ux2 F1, which revises the pagent "one call, no halves"
// rule): the call sees THIS FACT ONLY, never other facts and never a location
// line. Topics that exist because two facts sit side by side come from the
// deferred combination pass (lib/inference/handlers/topic-combo-handler.ts),
// cloud only.

import { loadSkill as defaultLoadSkill } from './skill-loader';
import { escapeUntrusted } from './state-line';
import { filterNearDuplicates, type DedupeDrop } from './topic-dedupe';
import { FILTER_DROP_JACCARD, contentJaccard, namesFact } from './topic-similarity';
import type { AgentModelResult, PlaceChain } from './types';

/** The only cap. There is NO per-persona ceiling. */
export const MAX_TOPICS_PER_FACT = 12;

/** Output budget. Thinking is OFF, so no reasoning headroom is added: measured,
 *  thinking ON returned EMPTY content on 8 of 10 probes at 8-10s because a
 *  ~2000-token trace ate the budget for a ~55-token answer, against 0.8-1.0s
 *  and a valid answer every time with it off. 12 topics plus JSON is ~140
 *  tokens, so 400 is comfortable. Do not re-enable thinking without a fresh
 *  A/B. */
export const TOPIC_CALL_MAX_TOKENS = 600;
export const TOPIC_CALL_TEMPERATURE = 0.3;

export interface TopicCallFact {
  statement: string;
  questionnaireAttribute?: string | null;
  placeChain?: PlaceChain | null;
  /** The fact's places as NAMES ("Bhopal, Madhya Pradesh, India"), never codes.
   *  Read at RUN time by the caller, never stored in a job payload. */
  places?: string;
}

export interface GenerateTopicsParams {
  fact: TopicCallFact;
  /** The skill id chosen upstream, e.g. `topics/residence`. Absent or unknown
   *  falls back to the group generic, never to a failure: inference_jobs is
   *  durable, so a job enqueued before an OTA outlives the build that named
   *  its skill. */
  skillId?: string;
  /** THIS FACT's topic texts, read at RUN time by the caller. Other facts'
   *  topics are not the isolated call's business. */
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
  /** "Generate more": every own topic is listed, and a run with nothing new is
   *  re-asked once rather than walking the empty ladder. */
  append?: boolean;
  /** Eval only: the ladder and the append run as they were before this arm. */
  promptArm?: 'null-control';
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
  /** The model wrapped its array in prose rather than answering with the array.
   *  Surfaced so the prompt fix is measurable. */
  proseAroundArray: boolean;
  /** The last answer was neither an array nor held one: it says nothing about
   *  the fact, so the caller must not read it as an empty answer. */
  malformed: boolean;
}

const FALLBACK_SKILL = 'topics/generic';

/** Appended when a guideline returned a well-formed but empty array. */
export const EMPTY_RETRY_NUDGE =
  'Your last answer was empty. Return at least 3 topics about this fact: what gets reported about it. Return [] again only if the fact is a negative or a placeholder.';

/** The empty ladder's last attempt, on `topics/generic`. Prose emphasis is not a
 *  lever on this model, so judgement gets its own attempt rather than a louder
 *  repeat of the nudge. */
export const JUDGEMENT_NUDGE =
  'No guideline fits this fact, so set them aside. Ask what news someone would want because this is true of them, and answer with those topics. Avoid stereotypes about who the person is. Return [] only if the fact is a negative or a placeholder.';

/** Why an append run is not the first run: the same brief twice gives the same list. */
export const APPEND_BRIEF =
  'This fact already has the topics above. Find new angles they do not cover: named people, organisations, rules, events and sub-areas.';

const LEGACY_EMPTY_RETRY_NUDGE =
  'Your last answer was empty. Return at least 3 topics about this fact: what gets reported about it.';

/**
 * The topic guideline for a fact whose caller named none (Profile retries,
 * "Generate more", a job from an older bundle): read off the attribute key's
 * words. Unknown falls back to `topics/generic`, never to a failure.
 */
export function topicSkillForAttribute(attribute: string | null | undefined): string {
  const words = (attribute ?? '').toLowerCase().split(/[^a-z]+/).filter(Boolean);
  const has = (...w: string[]) => words.some((x) => w.includes(x));
  // ORDER IS MEANING (ux2 F6, measured): family before location ("family:
  // parents location" is a relative's), expat and origin before residence
  // ("expat in country of residence" is the expat status), languages before
  // origin ("background: languages" returned [] from origin 6 of 6). A home
  // the user OWNS is property, not where they live: no ladder, generic.
  if (has('family', 'parents', 'relatives', 'partner', 'children', 'spouse')) return 'topics/family';
  if (has('languages', 'language', 'property')) return FALLBACK_SKILL;
  if (has('expat', 'origin', 'nationality', 'heritage')) return 'topics/origin';
  if (has('location', 'residence', 'neighborhood', 'neighbourhood')) return 'topics/residence';
  if (has('profession', 'job', 'occupation', 'employer', 'company', 'industry', 'career')) return 'topics/profession';
  if (has('hobbies', 'sport', 'sports', 'teams', 'entertainment', 'artists', 'interest', 'interests', 'topics', 'exercise')) return 'topics/interest';
  return FALLBACK_SKILL;
}

/** The place as the USER said it: the first rung after "live(s) in", with a
 *  canonical name in brackets dropped ("Porto Santo (Vila Baleira)" gives
 *  "Porto Santo"). Null when the statement names no home. */
function userPlaceTerm(statement: string): string | null {
  const m = /\blives?\s+in\s+([^,]+)/i.exec(statement);
  if (!m) return null;
  const term = m[1].replace(/\s*\([^)]*\)\s*$/, '').trim();
  return term.length >= 2 ? term : null;
}

export function normalizeTopicText(s: string): string {
  return s.toLowerCase().trim().replace(/\s+/g, ' ');
}

export function buildTopicUserMessage(p: GenerateTopicsParams): string {
  const lines: string[] = [`Fact: "${escapeUntrusted(p.fact.statement, 400)}"`];
  if (p.fact.questionnaireAttribute) {
    lines.push(`Attribute: ${escapeUntrusted(p.fact.questionnaireAttribute, 120)}`);
  }
  if (p.fact.places) lines.push(`Place: ${escapeUntrusted(p.fact.places, 200)}`);
  // A DEDUPE LIST, NOT CONTEXT (ux2 F6, measured): the model read the list as
  // facts about the person, and a school fact whose list held "Poland news"
  // came back with six Poland school topics. So this fact's own topics are
  // listed only when they name this fact, and the block says what it is.
  // Declined texts are always listed: the veto below needs them regardless.
  // "Generate more" lists them all: hidden from the model, an own topic comes
  // straight back as a repeat, and repeats are what stopped the taps adding.
  const showAll = p.append && p.promptArm !== 'null-control';
  const own = (p.existingTopics ?? []).filter((t) => t && (showAll || namesFact(t, p.fact.statement)));
  const exclusions = [...new Set([...own, ...(p.declinedTopics ?? []).filter(Boolean)])];
  if (exclusions.length > 0) {
    lines.push(
      `Already covered, do not repeat these (a dedupe list, not a hint about the person):\n${exclusions
        .map((s) => `- ${escapeUntrusted(s, 200)}`)
        .join('\n')}`,
    );
  }
  if (showAll) lines.push(APPEND_BRIEF);
  lines.push(`Generate at most ${p.ceiling ?? MAX_TOPICS_PER_FACT} topics — fewer is correct.`);
  return lines.join('\n');
}

/**
 * Capitalizes whole-word occurrences of the fact's place names ("bhopal water
 * cuts" -> "Bhopal water cuts"). `names` is the `Place:` string: segments split
 * on "," and ";", a leading "the " dropped. Never touches part of a word.
 */
export function capitalizePlaceNames(topics: string[], names: string | null | undefined): string[] {
  const segs = [...new Set(
    (names ?? '').split(/[;,]/).flatMap((n) => {
      const t = n.trim();
      return [t, t.replace(/^the\s+/i, '')];
    }).filter((n) => n.length >= 2 && !/^anywhere in the world$/i.test(n)),
  )].sort((a, b) => b.length - a.length);
  if (segs.length === 0) return topics;
  const esc = (x: string) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`(?<![\\p{L}\\p{N}])(${segs.map(esc).join('|')})(?![\\p{L}\\p{N}])`, 'giu');
  return topics.map((t) =>
    t.replace(re, (m) => segs.find((n) => n.toLowerCase() === m.toLowerCase()) ?? m),
  );
}

function asStringArray(parsed: unknown): string[] | null {
  if (!Array.isArray(parsed)) return null;
  return parsed
    .filter((x): x is string => typeof x === 'string' && x.trim().length > 0)
    .map((x) => x.trim());
}

function tryParse(text: string): string[] | null {
  try {
    return asStringArray(JSON.parse(text));
  } catch {
    return null;
  }
}

/**
 * The LAST balanced top-level `[...]` in the text, or null.
 *
 * Scans with a depth counter and a string-literal state machine rather than a
 * regex. The old `/\[[\s\S]*?\]/` was non-greedy, so on prose like
 * "I considered [Alkmaar, Hoorn] and settled on: [\"a b\", \"c d\"]" it
 * matched the FIRST bracket run and returned the wrong list; on a truncated
 * answer it could match a fragment and return a partial set as if it were
 * whole. LAST, because a model that reasons first puts its answer at the end.
 *
 * A bracket inside a string literal does not count, which is why the quote and
 * escape states exist: a topic containing "[" would otherwise unbalance it.
 */
export function lastBalancedArray(text: string): string | null {
  let start = -1;
  let depth = 0;
  let inString = false;
  let escaped = false;
  let best: string | null = null;

  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (c === '\\') escaped = true;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') { inString = true; continue; }
    if (c === '[') {
      if (depth === 0) start = i;
      depth++;
    } else if (c === ']') {
      if (depth > 0) {
        depth--;
        // Only a CLOSED top-level array counts, so a truncated tail is never
        // mistaken for a complete answer: it fails closed.
        if (depth === 0 && start !== -1) best = text.slice(start, i + 1);
      }
    }
  }
  return best;
}

export interface ParsedTopics {
  topics: string[];
  /** True when the array was recovered from surrounding prose rather than being
   *  the whole answer. 42% of skill-arm rows did this; counting it is how the
   *  prompt fix gets measured instead of guessed at. */
  proseAroundArray: boolean;
  /** No array anywhere in a non-empty answer. */
  malformed: boolean;
}

export function parseTopicsDetailed(output: string): ParsedTopics {
  const whole = tryParse(output.trim());
  if (whole) return { topics: whole, proseAroundArray: false, malformed: false };

  const block = lastBalancedArray(output);
  if (block) {
    const recovered = tryParse(block);
    if (recovered) return { topics: recovered, proseAroundArray: true, malformed: false };
  }
  return { topics: [], proseAroundArray: false, malformed: output.trim().length > 0 };
}

export function parseTopics(output: string): string[] {
  return parseTopicsDetailed(output).topics;
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

  const userMessage = buildTopicUserMessage({ ...params, ceiling });
  const call = (system: string, content: string) =>
    params.deps.callModel({
      role: 'topicgen',
      model: params.model ?? 'SMALL',
      systemPrompt: system,
      messages: [{ role: 'user', content }],
      temperature: TOPIC_CALL_TEMPERATURE,
      maxTokens: TOPIC_CALL_MAX_TOKENS,
      enableThinking: false,
    });

  const nullControl = params.promptArm === 'null-control';
  const appending = params.append === true && !nullControl;
  // Own and declined alike: a reworded repeat is not a new topic.
  const known = [...(params.existingTopics ?? []), ...(params.declinedTopics ?? [])].filter(Boolean);
  const knownKeys = new Set(known.map(normalizeTopicText));
  const isRepeat = (t: string) =>
    knownKeys.has(normalizeTopicText(t)) || known.some((k) => contentJaccard(t, k) >= FILTER_DROP_JACCARD);

  let result = await call(systemPrompt, userMessage);
  let decoded = parseTopicsDetailed(result.content);
  if (appending) {
    // One re-ask naming what came back, then stop: "nothing new" is an answer.
    const repeats = decoded.topics.filter(isRepeat);
    if (!result.error && decoded.topics.length === repeats.length) {
      const named = repeats.slice(0, 12).map((t) => `- ${escapeUntrusted(t, 200)}`).join('\n');
      const note = named ? `Your last answer only repeated:\n${named}\nName different subjects.` : 'Your last answer was empty. Name different subjects.';
      result = await call(systemPrompt, `${userMessage}\n${note}`);
      decoded = parseTopicsDetailed(result.content);
    }
  } else if (!result.error && decoded.topics.length === 0) {
    // AN ISOLATED SET NEVER SETTLES EMPTY (ux2 F6, measured: 29 of 120 were the
    // model's well-formed [] on running, languages, diet, travel). One retry on
    // the same guideline with a nudge, then `topics/generic` with judgement. A transport
    // ERROR is not retried: the caller records it and the card offers Retry.
    result = await call(systemPrompt, `${userMessage}\n${nullControl ? LEGACY_EMPTY_RETRY_NUDGE : EMPTY_RETRY_NUDGE}`);
    decoded = parseTopicsDetailed(result.content);
    const generic = loadSkillFn(FALLBACK_SKILL);
    if (!result.error && decoded.topics.length === 0 && generic && (!nullControl || generic !== systemPrompt)) {
      result = await call(generic, `${userMessage}\n${nullControl ? LEGACY_EMPTY_RETRY_NUDGE : JUDGEMENT_NUDGE}`);
      decoded = parseTopicsDetailed(result.content);
    }
  }
  const raw = appending ? decoded.topics.filter((t) => !isRepeat(t)) : decoded.topics;

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

  // THE USER'S OWN PLACE TERM (ux2 D13c): "Porto Santo" resolved to Vila
  // Baleira, and without a topic in the user's words no Porto Santo news is
  // ever found. The guideline asks for it; this makes sure of it.
  let topics = capitalizePlaceNames(deduped.kept.slice(0, ceiling), params.fact.places);
  const term =
    params.skillId === 'topics/residence' || params.skillId === 'topics/family'
      ? userPlaceTerm(params.fact.statement)
      : null;
  if (term && !topics.some((t) => t.toLowerCase().includes(term.toLowerCase()))) {
    const added = `${term} news`;
    if (!declined.has(normalizeTopicText(added))) {
      topics = [added, ...topics].slice(0, ceiling);
    }
  }

  return {
    topics,
    result,
    dropped: { veto: vetoed, filter: deduped.dropped.length },
    filterDrops: deduped.dropped,
    proseAroundArray: decoded.proseAroundArray,
    malformed: decoded.malformed,
  };
}
