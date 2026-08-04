// Hygiene Service — RN adapter for the weekly persona fact-hygiene sweep
// (Wave 11 U-B3/N6). Runs the pure analyzer (lib/news-harness/persona-management/
// fact-hygiene.ts) over live WatermelonDB persona rows, persists the current
// proposal set + the user's rejected-fingerprint memory via setting-service KV,
// and applies an accepted proposal's ops through the persona-action executor
// (invertible mutations) or fact-service (destructive deletes). Every applied
// cleanup lands a persona_change_log row so it shows up in the Wave-9 audit
// screen.
//
// No analysis math lives here — it is glue over the pure core + the existing
// per-collection services.

import logger from '../../logger';
import { toastManager } from '../../toast-manager';
import { ACTION_NAMES } from '../../news-harness/persona-management/action-names';
import {
  analyzeHygiene,
  type HygieneProposal,
  type HygieneOp,
  type HygieneFactInput,
  type HygieneAnalyzeInput,
} from '../../news-harness/persona-management/fact-hygiene';
import { getFacts, getFactSectionSnapshots, deleteFact } from './fact-service';
import { getAllTopicSnapshots } from './topic-service';
import { getSetting, setSetting } from './setting-service';
import { applyPersonaAction, type PersonaAction } from './persona-action-executor';
import * as sanityService from './topic-sanity-service';
import * as replacementService from './topic-replacement-service';
import * as changeLogService from './persona-change-log-service';

// ── KV keys + tunables ────────────────────────────────────────────────────

const PENDING_KEY = 'hygiene_pending_proposals';
const REJECTED_KEY = 'hygiene_rejected_fingerprints';
const LAST_SWEEP_KEY = 'hygiene_last_sweep_at';
/** Proposals produced but not yet SHOWN — see HYGIENE_PENDING_PRESENTATION_CAP. */
const BACKLOG_KEY = 'hygiene_proposal_backlog';

/**
 * Most proposals the review sheet ever holds at once.
 *
 * The one-time backfill can produce ~60 at a stroke, and a wall of 60 cards is a
 * dialog nobody reads — the user either bulk-accepts without looking or bounces.
 * Overflow is parked in a KV backlog and topped back up as each decision is
 * made, so the list stays short and self-refilling instead of being metered out
 * one sweep per week (which would take longer than the backlog it is draining).
 */
export const HYGIENE_PENDING_PRESENTATION_CAP = 10;

/** Don't sweep a persona with fewer facts than this — too little to clean. */
export const MIN_FACTS_FOR_SWEEP = 10;
/** Don't sweep a persona younger than this (ms) — avoids firing on fresh
 *  installs / first-runs before the profile has settled. 7 days. */
export const MIN_PERSONA_AGE_MS = 7 * 24 * 60 * 60 * 1000;
/** Minimum gap between real analyses (ms). Slightly under the 7d task
 *  frequency so a due tick isn't rejected by rounding. 6 days. */
export const SWEEP_COOLDOWN_MS = 6 * 24 * 60 * 60 * 1000;
/** Cap the remembered-rejections list so the KV blob can't grow unbounded. */
const MAX_REJECTED_FINGERPRINTS = 200;

/** Hard cap on how long the sweep waits for the LLM sanity audit before
 *  publishing without it. Sits under the task's 90s timeout, and the race NEVER
 *  rejects — a slow audit degrades to "no sanity proposals this week", never to
 *  a failed sweep or a retried (double-billed) call. */
export const SANITY_RACE_MS = 60_000;

export interface SweepResult {
  ran: boolean;
  reason?: 'cooldown' | 'too_few_facts' | 'persona_too_young';
  proposalCount: number;
}

/** Resolve `fn` normally, or `fallback` if it takes too long / throws. Never
 *  rejects — that property is what makes raising the task timeout safe. */
async function raceWithFallback<T>(
  promise: Promise<T>,
  ms: number,
  fallback: T,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise.catch(() => fallback),
      new Promise<T>((resolve) => {
        timer = setTimeout(() => resolve(fallback), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// ── Change notifier (Profile row / review sheet refresh) ───────────────────

type Listener = () => void;
const listeners = new Set<Listener>();

/** Subscribe to pending-proposal changes (sweep / accept / reject). Returns an
 *  unsubscribe fn. The Profile indicator row and review sheet use this to stay
 *  in sync without polling a reactive DB query. */
export function subscribeHygieneChange(cb: Listener): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

function notifyChange(): void {
  for (const cb of listeners) {
    try {
      cb();
    } catch {
      /* listener errors are non-fatal */
    }
  }
}

// ── KV read/write helpers ──────────────────────────────────────────────────

function parseArray<T>(raw: string | null): T[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as T[]) : [];
  } catch {
    return [];
  }
}

async function readPending(): Promise<HygieneProposal[]> {
  const rows = parseArray<HygieneProposal>(await getSetting(PENDING_KEY));
  // Defensive shape filter — drop anything that isn't a well-formed proposal.
  return rows.filter(
    (p) => p && typeof p.id === 'string' && Array.isArray(p.ops),
  );
}

async function writePending(proposals: HygieneProposal[]): Promise<void> {
  await setSetting(PENDING_KEY, JSON.stringify(proposals));
}

async function readBacklog(): Promise<HygieneProposal[]> {
  return parseArray<HygieneProposal>(await getSetting(BACKLOG_KEY)).filter(
    (p) => p && typeof p.id === 'string' && Array.isArray(p.ops),
  );
}

async function writeBacklog(proposals: HygieneProposal[]): Promise<void> {
  await setSetting(BACKLOG_KEY, JSON.stringify(proposals));
}

/**
 * Split a freshly-analyzed proposal set into what is shown now and what waits.
 * Order is preserved, so the analyzer's deterministic kind-ordering decides what
 * the user sees first.
 */
async function publishWithCap(proposals: HygieneProposal[]): Promise<void> {
  await writePending(proposals.slice(0, HYGIENE_PENDING_PRESENTATION_CAP));
  await writeBacklog(proposals.slice(HYGIENE_PENDING_PRESENTATION_CAP));
}

/**
 * After a decision removes a proposal, pull the next one forward immediately.
 * Immediate — not "next sweep" — because the backfill's whole point is clearing
 * a backlog fast; refilling weekly would drain 60 proposals slower than the four
 * weeks the one-time pass exists to beat.
 */
async function refillFromBacklog(remainingPending: HygieneProposal[]): Promise<void> {
  const room = HYGIENE_PENDING_PRESENTATION_CAP - remainingPending.length;
  if (room <= 0) {
    await writePending(remainingPending);
    return;
  }
  const backlog = await readBacklog();
  if (backlog.length === 0) {
    await writePending(remainingPending);
    return;
  }
  await writePending([...remainingPending, ...backlog.slice(0, room)]);
  await writeBacklog(backlog.slice(room));
}

async function readRejected(): Promise<string[]> {
  return parseArray<string>(await getSetting(REJECTED_KEY));
}

async function writeRejected(fingerprints: string[]): Promise<void> {
  // Keep the most-recent tail if we ever exceed the cap.
  const capped =
    fingerprints.length > MAX_REJECTED_FINGERPRINTS
      ? fingerprints.slice(fingerprints.length - MAX_REJECTED_FINGERPRINTS)
      : fingerprints;
  await setSetting(REJECTED_KEY, JSON.stringify(capped));
}

// ── Public getters ─────────────────────────────────────────────────────────

export async function getPendingProposals(): Promise<HygieneProposal[]> {
  return readPending();
}

/** Cheap count for the Profile indicator row (polled on focus + on change).
 *  Counts pending PLUS backlog: the sheet shows at most
 *  HYGIENE_PENDING_PRESENTATION_CAP at a time, but the user is told the real
 *  number of outstanding cleanups rather than the paging window. */
export async function getPendingCount(): Promise<number> {
  const [pending, backlog] = await Promise.all([readPending(), readBacklog()]);
  return pending.length + backlog.length;
}

// ── Sweep ──────────────────────────────────────────────────────────────────

/**
 * Analyze live persona data → store proposals → fire ONE hygiene notification
 * when there is anything to review. Guarded so it is safe to call on every
 * scheduler tick: skips when on cooldown, when the persona is too small, or too
 * young. Pass `force: true` (e.g. a debug trigger) to bypass the cooldown.
 */
export async function runHygieneSweep(opts?: {
  now?: number;
  force?: boolean;
}): Promise<SweepResult> {
  const now = opts?.now ?? Date.now();

  // Cooldown guard (KV stamp) — independent of the scheduler's own bookkeeping.
  if (!opts?.force) {
    const last = Number(await getSetting(LAST_SWEEP_KEY));
    if (Number.isFinite(last) && last > 0 && now - last < SWEEP_COOLDOWN_MS) {
      return { ran: false, reason: 'cooldown', proposalCount: await getPendingCount() };
    }
  }

  const [facts, sectionSnapshots, topics] = await Promise.all([
    getFacts(),
    getFactSectionSnapshots(),
    getAllTopicSnapshots(),
  ]);

  // Kick the LLM sanity audit off BEFORE the size/age gates. Those gates exist
  // for the four *cleanup* kinds ("too little to clean", "let the profile
  // settle") and neither rationale transfers: contamination is present from the
  // very first generation, is worse the more facts there are, and auditing a
  // young persona carries no false-positive risk. Left behind the gates, a
  // 9-fact persona would never be cleaned and a new user would wait 7 days to
  // see the topics they are complaining about today.
  const sanityPromise = raceWithFallback(
    sanityService.runSanityAudit({
      facts: facts.map((f) => ({ id: f.id, statement: f.statement })),
    }),
    SANITY_RACE_MS,
    { incoherentFacts: [], audited: 0 },
  );

  if (facts.length < MIN_FACTS_FOR_SWEEP) {
    return publishSanityOnly(await sanityPromise, facts, topics, now, 'too_few_facts');
  }

  // Persona age = time since the earliest fact was created.
  const createdTimes = sectionSnapshots
    .map((s) => s.createdAtMs)
    .filter((ms) => ms > 0);
  const earliest = createdTimes.length > 0 ? Math.min(...createdTimes) : now;
  if (now - earliest < MIN_PERSONA_AGE_MS) {
    return publishSanityOnly(await sanityPromise, facts, topics, now, 'persona_too_young');
  }

  // Join fact weight (from section snapshots) onto the analyzer input.
  const weightById = new Map(sectionSnapshots.map((s) => [s.id, s.weight]));
  const createdById = new Map(sectionSnapshots.map((s) => [s.id, s.createdAtMs]));
  const factInputs: HygieneFactInput[] = facts.map((f) => ({
    id: f.id,
    statement: f.statement,
    weight: weightById.get(f.id) ?? null,
    createdAtMs: createdById.get(f.id) ?? 0,
  }));

  const rejected = await readRejected();
  // Wait for the audit here — its verdicts must reach the SAME pending set and
  // the SAME single notification (persona-hygiene-task documents "fires ONE
  // hygiene notification"). Bounded and non-rejecting, so the worst case is
  // zero sanity proposals rather than a failed sweep.
  const sanity = await sanityPromise;
  const input: HygieneAnalyzeInput = {
    facts: factInputs,
    topics,
    now,
    rejectedFingerprints: rejected,
    incoherentFacts: sanity.incoherentFacts,
  };
  const proposals = analyzeHygiene(input);

  await publishWithCap(proposals);
  await setSetting(LAST_SWEEP_KEY, String(now));
  notifyChange();

  if (proposals.length > 0) {
    void toastManager.showNotifiedToast({
      type: 'hygiene',
      source: 'hygiene',
      title: 'hygiene.notificationTitle',
      body: 'hygiene.notificationBody',
      icon: 'cleaning-services',
      context: { count: proposals.length },
      actions: [{ id: 'review-hygiene', labelKey: 'hygiene.reviewChip' }],
    });
  }

  return { ran: true, proposalCount: proposals.length };
}

/**
 * Publish sanity proposals when the sweep bailed on the size/age gate.
 *
 * The four cleanup kinds are correctly withheld for a small or young persona,
 * but the sanity verdicts are not — so instead of returning `proposalCount: 0`
 * blindly, run the analyzer with an EMPTY fact list (which suppresses every
 * fact-derived kind) and publish whatever the audit found. `ran` stays false and
 * the reason is preserved, so the caller's bookkeeping is unchanged.
 */
async function publishSanityOnly(
  sanity: { incoherentFacts: HygieneAnalyzeInput['incoherentFacts'] },
  facts: { id: string; statement: string }[],
  topics: HygieneAnalyzeInput['topics'],
  now: number,
  reason: 'too_few_facts' | 'persona_too_young',
): Promise<SweepResult> {
  const incoherentFacts = sanity.incoherentFacts ?? [];
  if (incoherentFacts.length === 0) {
    return { ran: false, reason, proposalCount: await getPendingCount() };
  }

  const proposals = analyzeHygiene({
    // Facts ARE supplied (the summary needs their statements) but every
    // fact-derived kind needs >= 2 facts or a weight/staleness signal; the
    // incoherent kind is the only one these inputs can produce.
    facts: facts.map((f) => ({ id: f.id, statement: f.statement, weight: null, createdAtMs: now })),
    topics,
    now,
    rejectedFingerprints: await readRejected(),
    incoherentFacts,
  }).filter((p) => p.kind === 'incoherent_topics');

  if (proposals.length === 0) {
    return { ran: false, reason, proposalCount: await getPendingCount() };
  }

  await publishWithCap(proposals);
  notifyChange();
  void toastManager.showNotifiedToast({
    type: 'hygiene',
    source: 'hygiene',
    title: 'hygiene.notificationTitle',
    body: 'hygiene.notificationBody',
    icon: 'cleaning-services',
    context: { count: proposals.length },
    actions: [{ id: 'review-hygiene', labelKey: 'hygiene.reviewChip' }],
  });
  return { ran: false, reason, proposalCount: proposals.length };
}

// ── Accept / Reject ──────────────────────────────────────────────────────────

/**
 * Apply an `incoherent_topics` proposal as ONE unit (r12 K-P5).
 *
 * Handled off the generic op loop on purpose. The generic loop runs each op
 * independently — a mint through one writer, each retire through
 * applyPersonaAction's own write — which cannot give the atomicity this kind
 * needs. Here generation, minting and retiring are a single decision:
 *
 *   (a) generate first; ANY failure returns applied:false having changed
 *       nothing, and the proposal stays pending for another tap;
 *   (b) the mint and the retires land in ONE database.write/batch;
 *   (c) if replacements came back empty, the retire is withheld rather than
 *       leave the fact with zero active topics.
 *
 * The change-log rows are appended AFTER the write commits — an audit entry is
 * worth less than the invariant, so it must never be what forces the ordering.
 */
async function applyIncoherentTopicsProposal(
  proposal: HygieneProposal,
): Promise<AcceptResult> {
  const genOp = proposal.ops.find((op) => op.type === 'generate_replacements');
  if (!genOp || genOp.type !== 'generate_replacements') {
    return { applied: false, ok: false };
  }

  const retireIds = proposal.ops
    .filter(
      (op): op is Extract<HygieneOp, { type: 'persona_action' }> =>
        op.type === 'persona_action',
    )
    .map((op) => op.action.topicId)
    .filter((id): id is string => !!id);

  const outcome = await replacementService.generateAndReplace(
    genOp.factId,
    genOp.fillTo,
    retireIds,
  );

  if (!outcome.ok) {
    logger.warn('[hygiene] replacement generation failed — nothing retired', {
      proposalId: proposal.id,
      factId: genOp.factId,
    });
    return { applied: false, ok: false };
  }

  for (const topicId of retireIds.slice(0, outcome.retired)) {
    await changeLogService
      .append({
        actionType: ACTION_NAMES.RETIRE_TOPIC,
        action: { targetId: topicId },
        source: 'digest',
        summary: proposal.summary,
      })
      .catch(() => {
        /* audit only — never fails the applied change */
      });
  }

  const pending = await readPending();
  await refillFromBacklog(pending.filter((p) => p.id !== proposal.id));
  notifyChange();

  // floorHeld ⇒ the fact would have gone dark, so the removal was withheld.
  // Report it as not-fully-ok so the UI shows the retry toast rather than
  // claiming a cleanup that did not happen.
  return { applied: true, ok: !outcome.floorHeld };
}

export interface AcceptResult {
  applied: boolean;
  /** True when the proposal was found + all ops ran without a hard error. */
  ok: boolean;
}

/**
 * Apply a proposal's ops (executor for invertible persona actions; fact-service
 * for destructive deletes, each logged to persona_change_log with source
 * 'digest'), then remove it from the pending set. Never throws.
 */
export async function acceptProposal(id: string): Promise<AcceptResult> {
  const pending = await readPending();
  const proposal = pending.find((p) => p.id === id);
  if (!proposal) return { applied: false, ok: false };

  // `incoherent_topics` is generate-then-retire and needs its ops applied as a
  // single atomic unit, which the generic per-op loop below cannot provide.
  if (proposal.kind === 'incoherent_topics') {
    try {
      return await applyIncoherentTopicsProposal(proposal);
    } catch (error) {
      logger.captureException(error, {
        tags: { service: 'hygiene-service', method: 'acceptProposal.incoherent' },
      });
      return { applied: false, ok: false };
    }
  }

  let ok = true;
  for (const op of proposal.ops) {
    try {
      if (op.type === 'generate_replacements') {
        continue; // already handled in phase 1
      } else if (op.type === 'delete_fact') {
        await deleteFact(op.factId);
        await changeLogService.append({
          actionType: ACTION_NAMES.HYGIENE_DELETE_FACT,
          action: { targetId: op.factId },
          source: 'digest',
          summary: proposal.summary,
        });
      } else {
        // Structurally compatible with the executor's PersonaAction.
        const res = await applyPersonaAction(op.action as PersonaAction, 'digest');
        if (!res.applied) ok = false;
      }
    } catch (error) {
      ok = false;
      logger.captureException(error, {
        tags: { service: 'hygiene-service', method: 'acceptProposal', kind: proposal.kind },
      });
    }
  }

  await refillFromBacklog(pending.filter((p) => p.id !== id));
  notifyChange();
  return { applied: true, ok };
}

/**
 * Remember a proposal's fingerprint so the next sweep never re-proposes it, and
 * drop it from the pending set. Never throws.
 */
export async function rejectProposal(id: string): Promise<void> {
  const [pending, rejected] = await Promise.all([readPending(), readRejected()]);
  if (!rejected.includes(id)) {
    await writeRejected([...rejected, id]);
  }
  await refillFromBacklog(pending.filter((p) => p.id !== id));
  notifyChange();
}
