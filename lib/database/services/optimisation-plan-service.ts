// Optimisation-Plan Service — RN adapter for the Round-4 C5 daily feed tune-up.
//
// Once a day the deferred feed verdicts (article_feedback rows, processed_at
// null) are folded into ONE optimisation plan the user reviews in Mera chat.
// Nothing on the feed mutates the persona; this service is where the accumulated
// signals finally become persona ops — and only on explicit accept.
//
// Flow:
//   runOptimisationCycle()  (daily scheduler tick) → guards → load signals +
//     topic snapshots → analyzeFeedback (pure, deterministic candidates) → ONE
//     E2EE cloudComplete that ORGANIZES/annotates the candidates into an
//     auto/review plan (it may reword + pick defaults but NEVER invents ops) →
//     persist the pending plan (backed by the deterministic candidate registry)
//     + fire ONE `optimisation_plan` notification.
//   acceptPlan(selections) / dismissPlan() → apply the checked/selected ops via
//     the persona-action executor, mark ALL source rows processed, remember
//     skipped fingerprints so they're never re-proposed.
//
// Mirrors hygiene-service's structure (KV pending set + rejected-fingerprint
// memory + guards). No analysis math lives here — that is the pure digest core.

import { getSetting, setSetting } from './setting-service';
import {
  getUnprocessedFeedback,
  countUnprocessedFeedback,
  markFeedbackProcessed,
} from './article-feedback-service';
import { getAllTopicSnapshots, getAllByNormalizedText } from './topic-service';
import { applyPersonaAction, type PersonaAction } from './persona-action-executor';
import { cloudComplete } from '../../llm/cloudComplete';
import { SMALL_MODEL } from '../../llm/constants';
import { toastManager } from '../../toast-manager';
import logger from '../../logger';
import { ACTION_NAMES, type ActionName } from '../../news-harness/persona-management/action-names';
import {
  analyzeFeedback,
  type DigestCandidate,
  type DigestConflict,
  type DigestPersonaAction,
  type DigestSignal,
  type DigestSignalContext,
  type DigestTopicInput,
} from '../../news-harness/persona-management/feedback-digest';

// ── KV keys + tunables ────────────────────────────────────────────────────────

const PENDING_KEY = 'optimisation_pending_plan';
const REJECTED_KEY = 'optimisation_rejected_fingerprints';
const LAST_RUN_KEY = 'optimisation_last_run_at';

/** Don't run unless at least this many verdicts are waiting — too little to plan. */
export const MIN_UNPROCESSED_FOR_RUN = 3;
/** Minimum gap between real cycles (ms). Slightly under the 3h task frequency so
 *  a due (and idle-gated) tick isn't rejected by rounding. 2.5 hours. */
export const RUN_COOLDOWN_MS = 2.5 * 60 * 60 * 1000;
/** Newest N verdicts folded per cycle — keeps the digest + prompt bounded. */
export const MAX_SIGNALS_PER_RUN = 40;
/** Unprocessed verdicts older than this are swept as processed when a cycle
 *  produces no candidates (so a stale backlog can't wedge the guard). 30 days. */
export const STALE_SIGNAL_MS = 30 * 24 * 60 * 60 * 1000;
/** Cap the remembered-rejections list so the KV blob can't grow unbounded. */
const MAX_REJECTED_FINGERPRINTS = 200;

/** Model + output budget for the single organize completion (calibration parity). */
const PLAN_MODEL = SMALL_MODEL;
const PLAN_MAX_TOKENS = 512;
const PLAN_TEMPERATURE = 0.2;

// ── Persisted plan shape ──────────────────────────────────────────────────────

export interface PlanAutoChange {
  fingerprint: string;
  summary: string;
}

export type PlanOptionAction = 'apply' | 'skip' | 'alternative';

export interface PlanReviewOption {
  label: string;
  action: PlanOptionAction;
  /** Only for `alternative` — a validated weaker variant of the candidate op(s). */
  altOps?: DigestPersonaAction[];
}

export interface PlanReviewItem {
  fingerprint: string;
  question: string;
  options: PlanReviewOption[];
  defaultIndex: number;
  rationale: string;
  conflictsWith: DigestConflict[];
}

/** The deterministic candidate registry — the ONLY source of applicable ops. The
 *  LLM annotates the plan around these; it can never add an op that isn't here. */
export interface PlanCandidate {
  kind: DigestCandidate['kind'];
  summary: string;
  ops: DigestPersonaAction[];
  sourceRowIds: string[];
}

export interface PendingPlan {
  createdAt: number;
  autoChanges: PlanAutoChange[];
  reviewItems: PlanReviewItem[];
  candidates: Record<string, PlanCandidate>;
  allSourceRowIds: string[];
  status: 'pending' | 'accepted' | 'dismissed';
}

export interface CycleResult {
  ran: boolean;
  reason?: 'cooldown' | 'too_few_signals' | 'no_candidates';
  autoCount: number;
  reviewCount: number;
}

// ── KV read/write helpers ──────────────────────────────────────────────────────

function parseArray<T>(raw: string | null): T[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as T[]) : [];
  } catch {
    return [];
  }
}

async function readPending(): Promise<PendingPlan | null> {
  const raw = await getSetting(PENDING_KEY);
  if (!raw) return null;
  try {
    const plan = JSON.parse(raw) as PendingPlan;
    if (!plan || typeof plan !== 'object' || plan.status !== 'pending') return null;
    if (!plan.candidates || !Array.isArray(plan.autoChanges) || !Array.isArray(plan.reviewItems)) {
      return null;
    }
    return plan;
  } catch {
    return null;
  }
}

async function writePending(plan: PendingPlan | null): Promise<void> {
  await setSetting(PENDING_KEY, plan ? JSON.stringify(plan) : '');
}

async function readRejected(): Promise<string[]> {
  return parseArray<string>(await getSetting(REJECTED_KEY));
}

async function writeRejected(fingerprints: string[]): Promise<void> {
  const capped =
    fingerprints.length > MAX_REJECTED_FINGERPRINTS
      ? fingerprints.slice(fingerprints.length - MAX_REJECTED_FINGERPRINTS)
      : fingerprints;
  await setSetting(REJECTED_KEY, JSON.stringify(capped));
}

async function rememberRejected(fingerprints: string[]): Promise<void> {
  if (fingerprints.length === 0) return;
  const existing = await readRejected();
  const merged = [...existing];
  for (const fp of fingerprints) if (!merged.includes(fp)) merged.push(fp);
  await writeRejected(merged);
}

// ── Public getters ──────────────────────────────────────────────────────────────

/** The pending plan for the chat card, or null when nothing is queued. */
export async function getPendingPlan(): Promise<PendingPlan | null> {
  return readPending();
}

// ── Signal projection ───────────────────────────────────────────────────────────

/** Parse an article_feedback row's `context_json` into the digest context +
 *  tree path (the two are stored merged on the same snapshot). */
function parseContext(raw: string | null): { context: DigestSignalContext; treePath?: string[] } {
  if (!raw) return { context: {} };
  let parsed: Record<string, unknown>;
  try {
    const p = JSON.parse(raw);
    if (!p || typeof p !== 'object') return { context: {} };
    parsed = p as Record<string, unknown>;
  } catch {
    return { context: {} };
  }
  const context: DigestSignalContext = {};
  if (Array.isArray(parsed.matchedTopics)) {
    context.matchedTopics = parsed.matchedTopics
      .map((m) => {
        const rec = m && typeof m === 'object' ? (m as Record<string, unknown>) : {};
        const text = typeof rec.text === 'string' ? rec.text : '';
        if (!text) return null;
        return {
          text,
          topicId: typeof rec.topicId === 'string' ? rec.topicId : undefined,
          weight: typeof rec.weight === 'number' ? rec.weight : undefined,
        };
      })
      .filter((m): m is NonNullable<typeof m> => m !== null);
  }
  if (typeof parsed.relevance === 'number') context.relevance = parsed.relevance;
  if (typeof parsed.eventType === 'string') context.eventType = parsed.eventType;
  if (typeof parsed.category === 'string') context.category = parsed.category;
  if (typeof parsed.publication === 'string') context.publication = parsed.publication;
  if (typeof parsed.stableClusterId === 'string') context.stableClusterId = parsed.stableClusterId;
  const treePath = Array.isArray(parsed.treePath)
    ? parsed.treePath.filter((n): n is string => typeof n === 'string')
    : undefined;
  return { context, treePath: treePath && treePath.length > 0 ? treePath : undefined };
}

// ── The daily cycle ───────────────────────────────────────────────────────────

/**
 * Run one optimisation cycle. Guarded so it is safe to call on every scheduler
 * tick: skips on cooldown or when there are too few verdicts. When the digest
 * finds nothing actionable it sweeps stale verdicts as processed and exits;
 * otherwise it organizes the candidates (one E2EE call, deterministic fallback
 * on ANY failure), persists the pending plan (replacing any prior one), and
 * fires ONE notification. Pass `force: true` to bypass the cooldown.
 */
export async function runOptimisationCycle(opts?: {
  now?: number;
  force?: boolean;
}): Promise<CycleResult> {
  const now = opts?.now ?? Date.now();

  if (!opts?.force) {
    const last = Number(await getSetting(LAST_RUN_KEY));
    if (Number.isFinite(last) && last > 0 && now - last < RUN_COOLDOWN_MS) {
      return { ran: false, reason: 'cooldown', autoCount: 0, reviewCount: 0 };
    }
  }

  const unprocessedCount = await countUnprocessedFeedback();
  if (unprocessedCount < MIN_UNPROCESSED_FOR_RUN) {
    return { ran: false, reason: 'too_few_signals', autoCount: 0, reviewCount: 0 };
  }

  const [rows, topicSnapshots, rejected] = await Promise.all([
    getUnprocessedFeedback(), // newest-first
    getAllTopicSnapshots(),
    readRejected(),
  ]);

  const capped = rows.slice(0, MAX_SIGNALS_PER_RUN);
  const signals: DigestSignal[] = capped.map((r) => {
    const { context, treePath } = parseContext(r.contextJson);
    return {
      id: r.id,
      sentiment: r.sentiment === 'like' ? 'like' : 'dislike',
      title: r.title ?? '',
      createdAtMs: r.createdAt instanceof Date ? r.createdAt.getTime() : now,
      context,
      ...(treePath ? { treePath } : {}),
    };
  });

  const topics: DigestTopicInput[] = topicSnapshots.map((t) => ({
    id: t.id,
    text: t.text,
    normalizedText: t.normalizedText,
    weight: t.weight,
    status: t.status,
    highPriority: false, // unused by the analyzer; snapshot lacks it
  }));

  const candidates = analyzeFeedback({ signals, topics, now, rejectedFingerprints: rejected });

  // Stamp the run regardless of outcome so the cooldown holds.
  await setSetting(LAST_RUN_KEY, String(now));

  if (candidates.length === 0) {
    // Nothing actionable — sweep any long-stale verdicts so they can't wedge the
    // MIN_UNPROCESSED guard forever, then exit without a plan/notification.
    const staleIds = capped
      .filter((r) => (r.createdAt instanceof Date ? r.createdAt.getTime() : now) < now - STALE_SIGNAL_MS)
      .map((r) => r.id);
    if (staleIds.length > 0) await markFeedbackProcessed(staleIds);
    return { ran: true, reason: 'no_candidates', autoCount: 0, reviewCount: 0 };
  }

  // Build the deterministic candidate registry (the applicable-ops source).
  const registry: Record<string, PlanCandidate> = {};
  const allRowIds = new Set<string>();
  for (const cand of candidates) {
    registry[cand.fingerprint] = {
      kind: cand.kind,
      summary: cand.summary,
      ops: cand.ops,
      sourceRowIds: cand.sourceRowIds,
    };
    for (const id of cand.sourceRowIds) allRowIds.add(id);
  }

  // Organize into auto/review — LLM-annotated, deterministic fallback on failure.
  const organized = await organizePlan(candidates);

  const plan: PendingPlan = {
    createdAt: now,
    autoChanges: organized.autoChanges,
    reviewItems: organized.reviewItems,
    candidates: registry,
    allSourceRowIds: Array.from(allRowIds).sort(),
    status: 'pending',
  };
  await writePending(plan);

  const changeCount = plan.autoChanges.length + plan.reviewItems.length;
  void toastManager.showNotifiedToast({
    type: 'optimisation_plan',
    source: 'optimisation-plan',
    title: 'optimisationPlan.notificationTitle',
    body: 'optimisationPlan.notificationBody',
    icon: 'auto-fix-high',
    context: { count: changeCount },
    actions: [{ id: 'review-plan', labelKey: 'optimisationPlan.reviewChip' }],
  });

  return {
    ran: true,
    autoCount: plan.autoChanges.length,
    reviewCount: plan.reviewItems.length,
  };
}

// ── LLM organize step (annotate-only; ops never come from the model) ───────────

interface OrganizedPlan {
  autoChanges: PlanAutoChange[];
  reviewItems: PlanReviewItem[];
}

const PLAN_SYSTEM_PROMPT = [
  'You organize a daily news-feed "tune-up" plan for one user.',
  'You are given a list of DETERMINISTIC candidate changes to their interest',
  'profile, each with a stable "fingerprint", a kind, a short summary, and any',
  'liked stories it would collaterally affect ("conflicts").',
  '',
  'Split them into two sections:',
  '  • autoChanges — safe tweaks that need no decision (small "more/less about a',
  '    topic" nudges with NO conflicts). List {fingerprint, summary}.',
  '  • reviewItems — anything removing/suppressing content, or with conflicts.',
  '    For each: write a short plain-English question, 2-3 options, a defaultIndex',
  '    (your recommended option), and a one-line rationale. Options use',
  '    action "apply" or "skip"; use "alternative" ONLY for a GENTLER version of',
  '    the SAME change (e.g. lower weight instead of retire) — never a new change.',
  '',
  'You may reword and re-sort, but you MUST NOT invent fingerprints or ops, and',
  'every fingerprint you use must come from the input. Prefer the least',
  'destructive default when a change has conflicts.',
  '',
  'Respond with STRICT JSON only, no prose:',
  '{"autoChanges":[{"fingerprint":"...","summary":"..."}],',
  '"reviewItems":[{"fingerprint":"...","question":"...","options":[{"label":"...",',
  '"action":"apply"}],"defaultIndex":0,"rationale":"..."}]}',
].join('\n');

/** Compact single-line-per-candidate report (token-lean). */
function buildOrganizeUserMessage(candidates: DigestCandidate[]): string {
  const lines = candidates.map((c) => {
    const conflicts =
      c.conflictsWith.length > 0
        ? ` | conflicts: ${c.conflictsWith.map((x) => x.title).join('; ')}`
        : '';
    return `[${c.fingerprint}] ${c.kind} | ${c.summary}${conflicts}`;
  });
  return lines.join('\n');
}

async function organizePlan(candidates: DigestCandidate[]): Promise<OrganizedPlan> {
  let parsed: RawOrganized | null = null;
  try {
    const output = await cloudComplete({
      systemPrompt: PLAN_SYSTEM_PROMPT,
      prompt: buildOrganizeUserMessage(candidates),
      model: PLAN_MODEL,
      maxTokens: PLAN_MAX_TOKENS,
      temperature: PLAN_TEMPERATURE,
    });
    parsed = parseOrganized(output);
  } catch (err) {
    logger.captureException(err, {
      tags: { service: 'optimisation-plan-service', method: 'organizePlan.gateway' },
    });
  }
  return reconcile(candidates, parsed);
}

interface RawOrganized {
  autoFingerprints: Set<string>;
  reviewByFingerprint: Map<
    string,
    { question: string; options: PlanReviewOption[]; defaultIndex: number; rationale: string }
  >;
}

function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === 'object' ? (v as Record<string, unknown>) : null;
}

/** Defensively decode the model's JSON. Any failure → null (→ full fallback). */
function parseOrganized(output: string): RawOrganized | null {
  const match = (output ?? '').trim().match(/\{[\s\S]*\}/);
  if (!match) return null;
  let root: Record<string, unknown> | null;
  try {
    root = asRecord(JSON.parse(match[0]));
  } catch {
    return null;
  }
  if (!root) return null;

  const autoFingerprints = new Set<string>();
  if (Array.isArray(root.autoChanges)) {
    for (const a of root.autoChanges) {
      const rec = asRecord(a);
      if (rec && typeof rec.fingerprint === 'string') autoFingerprints.add(rec.fingerprint);
    }
  }

  const reviewByFingerprint = new Map<
    string,
    { question: string; options: PlanReviewOption[]; defaultIndex: number; rationale: string }
  >();
  if (Array.isArray(root.reviewItems)) {
    for (const r of root.reviewItems) {
      const rec = asRecord(r);
      if (!rec || typeof rec.fingerprint !== 'string') continue;
      const options: PlanReviewOption[] = [];
      if (Array.isArray(rec.options)) {
        for (const o of rec.options) {
          const orec = asRecord(o);
          if (!orec) continue;
          const label = typeof orec.label === 'string' ? orec.label.trim() : '';
          const action = orec.action;
          if (!label) continue;
          if (action === 'apply' || action === 'skip') {
            options.push({ label, action });
          } else if (action === 'alternative' && Array.isArray(orec.altOps)) {
            // altOps validated later against the candidate; carry raw for now.
            options.push({ label, action: 'alternative', altOps: orec.altOps as DigestPersonaAction[] });
          }
        }
      }
      reviewByFingerprint.set(rec.fingerprint, {
        question: typeof rec.question === 'string' ? rec.question.trim() : '',
        options,
        defaultIndex: typeof rec.defaultIndex === 'number' ? rec.defaultIndex : 0,
        rationale: typeof rec.rationale === 'string' ? rec.rationale.trim() : '',
      });
    }
  }
  return { autoFingerprints, reviewByFingerprint };
}

/**
 * Merge the (possibly-null) LLM annotation onto the deterministic candidate set
 * so EVERY candidate is placed exactly once and no op is ever lost or invented.
 * Safety rail: removal/suppression candidates and any candidate with conflicts
 * ALWAYS land in the review section (the model can't promote them to auto).
 */
function reconcile(candidates: DigestCandidate[], raw: RawOrganized | null): OrganizedPlan {
  const autoChanges: PlanAutoChange[] = [];
  const reviewItems: PlanReviewItem[] = [];

  for (const cand of candidates) {
    const mustReview = cand.confidence === 'review' || cand.conflictsWith.length > 0;
    const llmReview = raw?.reviewByFingerprint.get(cand.fingerprint);

    // Destructive / conflicting candidates ALWAYS go to review — the model can
    // annotate the question but can never promote them to a pre-checked auto.
    if (mustReview) {
      reviewItems.push(buildReviewItem(cand, llmReview));
      continue;
    }
    // Safe nudge. On LLM failure (raw === null) it defaults to auto; otherwise the
    // model may pull it into review, else it stays auto.
    if (raw !== null && llmReview) {
      reviewItems.push(buildReviewItem(cand, llmReview));
      continue;
    }
    autoChanges.push({ fingerprint: cand.fingerprint, summary: cand.summary });
  }
  return { autoChanges, reviewItems };
}

const GENERIC_OPTIONS: PlanReviewOption[] = [
  { label: 'Apply', action: 'apply' },
  { label: 'Skip', action: 'skip' },
];

function buildReviewItem(
  cand: DigestCandidate,
  llm?: { question: string; options: PlanReviewOption[]; defaultIndex: number; rationale: string },
): PlanReviewItem {
  let options: PlanReviewOption[] = GENERIC_OPTIONS;
  let question = cand.summary + '?';
  let rationale = '';
  let defaultIndex = 0;

  if (llm) {
    const validated = validateOptions(llm.options, cand);
    if (validated.length >= 2) options = validated;
    if (llm.question) question = llm.question;
    if (llm.rationale) rationale = llm.rationale;
    defaultIndex = clampIndex(llm.defaultIndex, options.length);
  }

  return {
    fingerprint: cand.fingerprint,
    question,
    options,
    defaultIndex,
    rationale,
    conflictsWith: cand.conflictsWith,
  };
}

function clampIndex(i: number, len: number): number {
  if (!Number.isInteger(i) || i < 0) return 0;
  return i >= len ? 0 : i;
}

/**
 * Keep only well-formed apply/skip options and `alternative` options whose altOps
 * are a validated WEAKER variant of the candidate's own op (same action_type +
 * target, magnitude no larger). Ensures an apply + skip pair always exists.
 */
function validateOptions(options: PlanReviewOption[], cand: DigestCandidate): PlanReviewOption[] {
  const out: PlanReviewOption[] = [];
  let hasApply = false;
  let hasSkip = false;
  for (const o of options) {
    if (o.action === 'apply') {
      out.push({ label: o.label, action: 'apply' });
      hasApply = true;
    } else if (o.action === 'skip') {
      out.push({ label: o.label, action: 'skip' });
      hasSkip = true;
    } else if (o.action === 'alternative') {
      const altOps = validateAltOps(o.altOps ?? [], cand);
      if (altOps.length > 0) out.push({ label: o.label, action: 'alternative', altOps });
    }
  }
  if (!hasApply) out.unshift({ label: 'Apply', action: 'apply' });
  if (!hasSkip) out.push({ label: 'Skip', action: 'skip' });
  return out;
}

/** An altOp is accepted only as a gentler version of the candidate's op. */
function validateAltOps(altOps: DigestPersonaAction[], cand: DigestCandidate): DigestPersonaAction[] {
  const base = cand.ops[0];
  if (!base || !Array.isArray(altOps)) return [];
  const out: DigestPersonaAction[] = [];
  for (const alt of altOps) {
    if (!alt || alt.action_type !== base.action_type) continue;
    // Weight nudge: same target + same sign + no larger magnitude.
    if (base.action_type === ACTION_NAMES.SET_TOPIC_WEIGHT) {
      if (typeof alt.delta !== 'number' || typeof base.delta !== 'number') continue;
      if (Math.sign(alt.delta) !== Math.sign(base.delta)) continue;
      if (Math.abs(alt.delta) > Math.abs(base.delta) || alt.delta === 0) continue;
      out.push({
        action_type: base.action_type,
        ...(base.topicId ? { topicId: base.topicId } : {}),
        ...(base.topicText ? { topicText: base.topicText } : {}),
        delta: alt.delta,
      });
    } else if (base.action_type === ACTION_NAMES.RETIRE_TOPIC) {
      // A gentler "retire" = a down-weight nudge on the same topic.
      if (typeof alt.delta !== 'number' || alt.delta >= 0) continue;
      out.push({
        action_type: ACTION_NAMES.SET_TOPIC_WEIGHT,
        ...(base.topicId ? { topicId: base.topicId } : {}),
        ...(base.topicText ? { topicText: base.topicText } : {}),
        delta: Math.max(-0.5, alt.delta),
      });
    } else if (base.action_type === ACTION_NAMES.ADD_SUPPRESSION) {
      const strength =
        typeof alt.suppressionStrength === 'number'
          ? Math.min(alt.suppressionStrength, base.suppressionStrength ?? 0.5)
          : (base.suppressionStrength ?? 0.5);
      if (strength <= 0) continue;
      out.push({ ...base, suppressionStrength: strength });
    }
    // Publication prefs have no meaningful "weaker" variant — dropped.
  }
  return out;
}

// ── Accept / dismiss ──────────────────────────────────────────────────────────

export interface AcceptSelections {
  /** Auto-change fingerprints the user UNCHECKED (default: all checked). */
  uncheckedAuto?: string[];
  /** review fingerprint → chosen option index (default: the item's defaultIndex). */
  reviewChoices?: Record<string, number>;
}

export interface AcceptResult {
  applied: boolean;
  /** Number of ops that actually mutated the persona (rails may reject some). */
  appliedOps: number;
  /** Non-applied / invalid ops surfaced as error lines. */
  errors: string[];
}

/**
 * Apply the checked auto changes + the selected review options, mark ALL of the
 * plan's source verdicts processed, and remember the skipped/unchecked
 * fingerprints so they're never re-proposed. Never throws.
 */
export async function acceptPlan(selections?: AcceptSelections): Promise<AcceptResult> {
  const plan = await readPending();
  if (!plan) return { applied: false, appliedOps: 0, errors: ['no pending plan'] };

  const unchecked = new Set(selections?.uncheckedAuto ?? []);
  const choices = selections?.reviewChoices ?? {};
  const errors: string[] = [];
  const skippedFingerprints: string[] = [];
  let appliedOps = 0;

  // Auto section: apply everything not explicitly unchecked.
  for (const change of plan.autoChanges) {
    if (unchecked.has(change.fingerprint)) {
      skippedFingerprints.push(change.fingerprint);
      continue;
    }
    const cand = plan.candidates[change.fingerprint];
    if (!cand) continue;
    appliedOps += await applyOps(cand.ops, change.fingerprint, errors);
  }

  // Review section: apply the selected option per item.
  for (const item of plan.reviewItems) {
    const cand = plan.candidates[item.fingerprint];
    if (!cand) continue;
    const idx = clampIndex(
      typeof choices[item.fingerprint] === 'number' ? choices[item.fingerprint] : item.defaultIndex,
      item.options.length,
    );
    const option = item.options[idx];
    if (!option || option.action === 'skip') {
      skippedFingerprints.push(item.fingerprint);
      continue;
    }
    const ops = option.action === 'alternative' && option.altOps ? option.altOps : cand.ops;
    appliedOps += await applyOps(ops, item.fingerprint, errors);
  }

  await markFeedbackProcessed(plan.allSourceRowIds);
  await rememberRejected(skippedFingerprints);
  await writePending({ ...plan, status: 'accepted' });

  return { applied: true, appliedOps, errors };
}

/** Discard the plan: remember all fingerprints, mark source rows processed, clear. */
export async function dismissPlan(): Promise<void> {
  const plan = await readPending();
  if (!plan) return;
  const allFingerprints = [
    ...plan.autoChanges.map((a) => a.fingerprint),
    ...plan.reviewItems.map((r) => r.fingerprint),
  ];
  await markFeedbackProcessed(plan.allSourceRowIds);
  await rememberRejected(allFingerprints);
  await writePending({ ...plan, status: 'dismissed' });
}

// ── Op application (validate → resolve → executor) ─────────────────────────────

const ACTION_VALUES: ReadonlySet<string> = new Set(Object.values(ACTION_NAMES));

/** Apply a candidate's ops, resolving topic text→id and validating shapes. */
async function applyOps(
  ops: DigestPersonaAction[],
  fingerprint: string,
  errors: string[],
): Promise<number> {
  let applied = 0;
  for (const raw of ops) {
    const action = await toValidPersonaAction(raw);
    if (!action) {
      errors.push(`${fingerprint}: skipped invalid op ${raw?.action_type ?? '?'}`);
      logger.warn('[optimisation-plan-service] skipped invalid op', {
        fingerprint,
        actionType: raw?.action_type,
      });
      continue;
    }
    try {
      const res = await applyPersonaAction(action, 'feedback');
      if (res.applied) applied += 1;
      else errors.push(`${fingerprint}: ${res.summary}`);
    } catch (err) {
      errors.push(`${fingerprint}: apply failed`);
      logger.captureException(err, {
        tags: { service: 'optimisation-plan-service', method: 'applyOps', fingerprint },
      });
    }
  }
  return applied;
}

/** Resolve a topic-text-only op to a topic id + validate the executor shape.
 *  Returns null when the op can't be safely applied (→ skipped + logged). */
async function toValidPersonaAction(
  op: DigestPersonaAction,
): Promise<PersonaAction | null> {
  if (!op || !ACTION_VALUES.has(op.action_type)) return null;
  const type = op.action_type as ActionName;

  if (type === ACTION_NAMES.SET_TOPIC_WEIGHT) {
    if (typeof op.delta !== 'number' || op.delta === 0) return null;
    const topicId = op.topicId ?? (await resolveTopicId(op.topicText));
    if (!topicId) return null;
    return { action_type: type, topicId, delta: op.delta };
  }
  if (type === ACTION_NAMES.RETIRE_TOPIC) {
    const topicId = op.topicId ?? (await resolveTopicId(op.topicText));
    if (!topicId) return null;
    return { action_type: type, topicId };
  }
  if (type === ACTION_NAMES.ADD_SUPPRESSION) {
    const pattern = op.suppressionPattern?.trim();
    if (!pattern) return null;
    return {
      action_type: type,
      suppressionPattern: pattern,
      ...(op.suppressionKeywords ? { suppressionKeywords: op.suppressionKeywords } : {}),
      ...(typeof op.suppressionStrength === 'number'
        ? { suppressionStrength: op.suppressionStrength }
        : {}),
    };
  }
  if (type === ACTION_NAMES.SET_PUBLICATION_PREF) {
    if (!op.publicationId || !op.publicationPref) return null;
    return { action_type: type, publicationId: op.publicationId, publicationPref: op.publicationPref };
  }
  return null;
}

/** Resolve a matched-topic text to the strongest ACTIVE topic id (or null). */
async function resolveTopicId(topicText?: string): Promise<string | null> {
  const text = topicText?.trim();
  if (!text) return null;
  const rows = await getAllByNormalizedText(text);
  const active = rows.filter((t) => t.status === 'active');
  if (active.length === 0) return null;
  active.sort((a, b) => Math.abs(b.weight) - Math.abs(a.weight));
  return active[0].id;
}
