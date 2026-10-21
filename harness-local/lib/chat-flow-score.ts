// harness-local — judge one on-device chat turn (persona, article, follow-story)
// against its fixture, the same way for the 'kev' and 'single' routes. Pure.
//
// Fixed before the dev baseline (P6d) and frozen once the test split is read:
// - ask_choice is not an action. `ask` (no | allowed | required) and
//   `askMentions` are checked against the chip labels; every other expectation
//   is checked on the ACTION calls only.
// - An ask with any action staged beside it fails ("nothing changes until the
//   user answers", D39).
// - A typed yes on a choose-one card with several options is refused by the
//   executor, so that applyProposal counts as nothing applied.
// - Saves are judged after the app's fact filter (the save executor runs it on
//   both routes); `replaces` survives the filter.
// - A canned fallback reply (the writer was called and failed) never passes an
//   `answer` turn.
// - Intent is a separate metric, never part of pass: the single route has no
//   intent for persona and follow-story, so it is read off the actions there.
//   follow_this_story = follow_a_named_story and thanks_or_ack =
//   question_or_chat are one act each.

import { filterFactChoiceGroups, normalizeStatement, type FactEntry } from '../../lib/news-harness/persona-management/fact-rules';
import { scoreOptions, type OptionCheck } from './option-quality';

export type Flow = 'persona' | 'article' | 'follow';
export type Ask = 'no' | 'allowed' | 'required';

export interface Call {
  name: string;
  input: Record<string, unknown>;
}

export interface Expect {
  /** Article / follow: the turn's expected outcome. Persona: undefined. */
  kind?: 'proposeTrack' | 'proposeFactCheck' | 'answer' | 'proposeChanges' | 'applyProposal' | 'cancelProposal';
  intent?: string | string[];
  ask?: Ask;
  askMentions?: string[];
  /** Article: the topic text or the publication a change must name. */
  target?: string;
  // Persona
  calls?: string[];
  toolCalled?: string;
  toolNotCalled?: string;
  saveMentions?: string[];
  deleteIds?: string[];
  replaceIds?: string[];
}

export interface TurnOutcome {
  route: 'kev' | 'single';
  calls: Call[];
  reply: string;
  /** Kev route: the intent read (Kev's top reading, a rule or a tap). Single: the article reply's intent, else null. */
  intent: string | null;
  /** The writer was called and every call failed, so a fixed reply went out. */
  fallbackReply: boolean;
  /** The pending card is choose-one with several options: a typed yes cannot apply it. */
  tapOnly: boolean;
  /** Persona: saved statements on file, for the app's fact filter. */
  known?: string[];
  /** Options the writer returned before the reader cut any (option quality's raw count). */
  rawOptionCount?: number;
}

export interface Verdict {
  pass: boolean;
  why: string;
  asked: boolean;
  askOptions: string[];
  /** null when the fixture has no intent label. */
  intentOk: boolean | null;
  routeIntent: string;
  /** Article less / more / mute with a target: the change named it. null otherwise. */
  targetOk: boolean | null;
  /** proposeTrack turns: option-quality fails ([] = pass). null otherwise. */
  optionFails: OptionCheck[] | null;
}

const SAME_ACT: Record<string, string> = {
  thanks_or_ack: 'question_or_chat',
  follow_this_story: 'follow_a_named_story',
};
const act = (intent: string) => SAME_ACT[intent] ?? intent;

const ARTICLE_SINGLE_INTENT: Record<string, string> = {
  answer: 'answer_question',
  track: 'follow_story',
  less: 'see_less',
  more: 'see_more',
  mute: 'mute_source',
  confirm: 'agree_to_card',
  cancel: 'decline_card',
};

const has = (calls: Call[], name: string) => calls.some((c) => c.name === name);
const sameSet = (a: readonly string[], b: readonly string[]) =>
  [...new Set(a)].sort().join(',') === [...new Set(b)].sort().join(',');

function savedEntries(calls: Call[]): Record<string, unknown>[] {
  return calls
    .filter((c) => c.name === 'saveExtractedFacts')
    .flatMap((c) => (c.input.extracted_user_information as Record<string, unknown>[]) ?? []);
}

/** Saves through the app's filterFactChoiceGroups, one entry at a time so `replaces` is kept. */
export function afterFactFilter(calls: Call[], known: readonly string[]): Call[] {
  const existing = known.map(normalizeStatement);
  return calls.flatMap((c) => {
    if (c.name !== 'saveExtractedFacts') return [c];
    const kept = savedEntries([c]).filter(
      (e) => filterFactChoiceGroups([e as unknown as FactEntry], existing).groups.length > 0,
    );
    return kept.length > 0 ? [{ ...c, input: { ...c.input, extracted_user_information: kept } }] : [];
  });
}

/** The calls that change something: ask_choice out, a refused typed yes out, saves filtered. */
export function actions(o: TurnOutcome): Call[] {
  let calls = o.calls.filter((c) => c.name !== 'ask_choice');
  if (o.tapOnly) calls = calls.filter((c) => c.name !== 'applyProposal');
  return o.known ? afterFactFilter(calls, o.known) : calls;
}

export function askOptions(calls: Call[]): string[] {
  const ask = calls.find((c) => c.name === 'ask_choice');
  return ask && Array.isArray(ask.input.options) ? (ask.input.options as unknown[]).map(String) : [];
}

const mentioned = (mention: string, texts: string[]) =>
  mention.toLowerCase().split('|').some((alt) => texts.some((t) => t.toLowerCase().includes(alt)));

/** The intent the turn acted on, read off its actions (single route, persona and follow-story). */
export function intentFromActions(flow: Flow, acts: Call[]): string {
  if (has(acts, 'applyProposal')) return 'agree_to_card';
  if (has(acts, 'cancelProposal')) return 'decline_card';
  if (flow === 'persona') {
    const saves = savedEntries(acts);
    if (saves.some((e) => e.replaces) || (saves.length > 0 && has(acts, 'deleteUserFacts'))) return 'correct_fact';
    if (saves.length > 0) return 'share_new_fact';
    if (has(acts, 'deleteUserFacts')) return 'remove_fact';
    return 'question_or_chat';
  }
  if (flow === 'follow') return has(acts, 'proposeTrack') ? 'follow_a_named_story' : 'question_or_other';
  if (has(acts, 'proposeTrack')) return 'follow_story';
  return 'answer_question';
}

function personaActs(e: Expect, acts: Call[]): string | null {
  const names = acts.map((c) => c.name);
  const correction = e.replaceIds !== undefined;
  if (e.calls && !correction && !sameSet(names, e.calls)) return `calls [${names.join(',')}]`;
  if (e.toolCalled && !names.includes(e.toolCalled)) return `no ${e.toolCalled}`;
  if (e.toolNotCalled && names.includes(e.toolNotCalled)) return `called ${e.toolNotCalled}`;
  const saved = savedEntries(acts).map((x) => String(x.statement ?? ''));
  for (const m of e.saveMentions ?? []) if (!mentioned(m, saved)) return `no saved statement names ${m}`;
  const deleted = acts.filter((c) => c.name === 'deleteUserFacts').flatMap((c) => (c.input.fact_ids as string[]) ?? []);
  if (e.deleteIds && !sameSet(deleted, e.deleteIds)) return `deleted [${deleted.join(',')}]`;
  if (e.replaceIds) {
    const replaced = savedEntries(acts).flatMap((x) => (typeof x.replaces === 'string' ? [x.replaces] : []));
    // A correction is a save that replaces the old fact, or a save beside a staged delete of it.
    if (!sameSet(replaced, e.replaceIds) && !sameSet(deleted, e.replaceIds)) {
      return `replaced [${replaced.join(',')}] deleted [${deleted.join(',')}]`;
    }
  }
  return null;
}

function changeNames(c: Call, intent: string, target: string): boolean {
  const list = (c.input.actions as Record<string, unknown>[]) ?? [];
  if (intent === 'mute_source') {
    return list.some((a) => a.type === 'set_publication_pref' && a.publicationPref === 'mute' && a.publicationId === target);
  }
  const sign = intent === 'see_less' ? -1 : 1;
  return list.some((a) => a.type === 'set_topic_weight' && a.topicText === target && Math.sign(Number(a.delta)) === sign);
}

function outcomeActs(e: Expect, o: TurnOutcome, acts: Call[]): string | null {
  const names = acts.map((c) => c.name);
  const only = (name: string) => names.length === 1 && names[0] === name;
  switch (e.kind) {
    case 'proposeTrack': {
      const n = ((acts.find((c) => c.name === 'proposeTrack')?.input.options as unknown[]) ?? []).length;
      return only('proposeTrack') && n >= 3 && n <= 4 ? null : `calls [${names.join(',')}] options=${n}`;
    }
    case 'proposeChanges': {
      if (!only('proposeChanges')) return `calls [${names.join(',')}]`;
      const intent = act(Array.isArray(e.intent) ? e.intent[0] : e.intent ?? '');
      return !e.target || changeNames(acts[0], intent, e.target) ? null : 'change names the wrong target';
    }
    case 'applyProposal':
    case 'cancelProposal':
      return only(e.kind) ? null : `calls [${names.join(',')}]`;
    default:
      // answer, and proposeFactCheck (cloud-only, so an answer on-device)
      if (names.length > 0) return `calls [${names.join(',')}]`;
      if (!o.reply.trim()) return 'empty reply';
      if (o.fallbackReply) return 'fixed fallback reply';
      return null;
  }
}

export interface JudgeInput {
  flow: Flow;
  expect: Expect;
  outcome: TurnOutcome;
  /** proposeTrack turns: the article's title and description, or the user's message. */
  optionSource?: string;
  /** YYYY-MM-DD, for the ended-season check. */
  today: string;
}

export function judgeTurn({ flow, expect: e, outcome: o, optionSource, today }: JudgeInput): Verdict {
  const acts = actions(o);
  const chips = askOptions(o.calls);
  const asked = chips.length > 0;
  const ask: Ask = e.ask ?? 'no';
  const routeIntent =
    o.route === 'kev' && o.intent
      ? o.intent
      : flow === 'article' && o.intent
        ? ARTICLE_SINGLE_INTENT[o.intent] ?? o.intent
        : intentFromActions(flow, acts);
  const wanted = e.intent === undefined ? null : (Array.isArray(e.intent) ? e.intent : [e.intent]).map(act);
  const intentOk = wanted ? wanted.includes(act(routeIntent)) : null;

  let why: string | null;
  if (asked) {
    if (ask === 'no') why = 'asked on a clear turn';
    else if (acts.length > 0) why = `asked and acted [${acts.map((c) => c.name).join(',')}]`;
    else why = (e.askMentions ?? []).filter((m) => !mentioned(m, chips)).map((m) => `chips miss ${m}`)[0] ?? null;
  } else if (ask === 'required') {
    why = 'did not ask';
  } else {
    why = flow === 'persona' ? personaActs(e, acts) : outcomeActs(e, o, acts);
  }

  const intentForTarget = act(Array.isArray(e.intent) ? e.intent[0] ?? '' : e.intent ?? '');
  const targetOk =
    e.target && ['see_less', 'see_more', 'mute_source'].includes(intentForTarget)
      ? acts.length === 1 && acts[0].name === 'proposeChanges' && changeNames(acts[0], intentForTarget, e.target)
      : null;

  let optionFails: OptionCheck[] | null = null;
  if (e.kind === 'proposeTrack' && optionSource !== undefined) {
    const options = ((acts.find((c) => c.name === 'proposeTrack')?.input.options as { label: string; search: string }[]) ?? []);
    optionFails = scoreOptions({ source: optionSource, options, rawCount: Math.max(o.rawOptionCount ?? 0, options.length), today });
  }

  return { pass: why === null, why: why ?? 'ok', asked, askOptions: chips, intentOk, routeIntent, targetOk, optionFails };
}

// ---------------------------------------------------------------------------
// Aggregation: one table row per flow x arm x split, from run-chat-flows rows.

export interface FlowRow extends Verdict {
  flow: Flow;
  fixture: string;
  split: string;
  arm: string;
  route: 'kev' | 'single';
  repeat: number;
  /** clear: false marks a turn where asking is right; every other turn counts for the ask rate. */
  clear: boolean;
  /** A failure the phone could not cause (bridge or server down): the row is left out. */
  dropped: string | null;
  /** A model outcome the user would see as an error (single call failed, or Kev failed and then the single call). */
  visibleError: string | null;
  fallbackReply: boolean;
  /** Kev threw, so the agent ran the single call (tryKev). */
  kevFallback: boolean;
  wallMs: number;
  decideMs: number;
  writeMs: number;
}

export interface ArmSummary {
  flow: Flow;
  arm: string;
  split: string;
  n: number;
  pass: number;
  intent: [number, number];
  target: [number, number];
  options: [number, number];
  askOnClear: [number, number];
  visibleErrors: number;
  fallbackReplies: number;
  kevFallbacks: number;
  dropped: number;
  wallP50: number;
  decideP50: number | null;
  writeP50: number | null;
}

function median(xs: number[]): number {
  if (xs.length === 0) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor((s.length - 1) / 2)];
}

export function summariseRows(rows: FlowRow[]): ArmSummary[] {
  const groups = new Map<string, FlowRow[]>();
  for (const r of rows) {
    const k = `${r.flow}|${r.arm}|${r.split}`;
    groups.set(k, [...(groups.get(k) ?? []), r]);
  }
  return [...groups.values()].map((all) => {
    const xs = all.filter((r) => !r.dropped);
    const frac = (pick: (r: FlowRow) => boolean | null): [number, number] => {
      const labelled = xs.map(pick).filter((v): v is boolean => v !== null);
      return [labelled.filter(Boolean).length, labelled.length];
    };
    const decided = xs.filter((r) => r.route === 'kev' && r.decideMs > 0).map((r) => r.decideMs);
    const written = xs.filter((r) => r.route === 'kev' && r.writeMs > 0).map((r) => r.writeMs);
    return {
      flow: all[0].flow,
      arm: all[0].arm,
      split: all[0].split,
      n: xs.length,
      pass: xs.filter((r) => r.pass).length,
      intent: frac((r) => r.intentOk),
      target: frac((r) => r.targetOk),
      options: frac((r) => (r.optionFails ? r.optionFails.length === 0 : null)),
      askOnClear: frac((r) => (r.clear ? r.asked : null)),
      visibleErrors: xs.filter((r) => r.visibleError).length,
      fallbackReplies: xs.filter((r) => r.fallbackReply).length,
      kevFallbacks: xs.filter((r) => r.kevFallback).length,
      dropped: all.length - xs.length,
      wallP50: median(xs.map((r) => r.wallMs)),
      decideP50: decided.length ? median(decided) : null,
      writeP50: written.length ? median(written) : null,
    };
  });
}

const pct = ([a, b]: [number, number]) => (b === 0 ? '-' : `${a}/${b} (${Math.round((a / b) * 100)}%)`);

/** Markdown table, flows then splits then arms. */
export function summaryTable(summaries: ArmSummary[]): string {
  const head =
    '| flow | split | arm | pass | intent | target | option quality | ask on clear | visible errors | fixed replies | Kev fell back | dropped | turn p50 ms | Kev step p50 ms | writer step p50 ms |\n' +
    '|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|';
  const order = (s: ArmSummary) => `${['persona', 'article', 'follow'].indexOf(s.flow)}|${s.split}|${s.arm}`;
  const lines = [...summaries]
    .sort((a, b) => (order(a) < order(b) ? -1 : 1))
    .map((s) =>
      `| ${s.flow} | ${s.split} | ${s.arm} | ${pct([s.pass, s.n])} | ${pct(s.intent)} | ${pct(s.target)} | ${pct(s.options)} | ${pct(s.askOnClear)} | ${s.visibleErrors} | ${s.fallbackReplies} | ${s.kevFallbacks} | ${s.dropped} | ${s.wallP50} | ${s.decideP50 ?? '-'} | ${s.writeP50 ?? '-'} |`,
    );
  return [head, ...lines].join('\n');
}
