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
  type HygieneFactInput,
  type HygieneAnalyzeInput,
} from '../../news-harness/persona-management/fact-hygiene';
import { getFacts, getFactSectionSnapshots, deleteFact } from './fact-service';
import { getAllTopicSnapshots } from './topic-service';
import { getSetting, setSetting } from './setting-service';
import { applyPersonaAction, type PersonaAction } from './persona-action-executor';
import * as changeLogService from './persona-change-log-service';

// ── KV keys + tunables ────────────────────────────────────────────────────

const PENDING_KEY = 'hygiene_pending_proposals';
const REJECTED_KEY = 'hygiene_rejected_fingerprints';
const LAST_SWEEP_KEY = 'hygiene_last_sweep_at';

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

export interface SweepResult {
  ran: boolean;
  reason?: 'cooldown' | 'too_few_facts' | 'persona_too_young';
  proposalCount: number;
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

/** Cheap count for the Profile indicator row (polled on focus + on change). */
export async function getPendingCount(): Promise<number> {
  return (await readPending()).length;
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

  if (facts.length < MIN_FACTS_FOR_SWEEP) {
    return { ran: false, reason: 'too_few_facts', proposalCount: 0 };
  }

  // Persona age = time since the earliest fact was created.
  const createdTimes = sectionSnapshots
    .map((s) => s.createdAtMs)
    .filter((ms) => ms > 0);
  const earliest = createdTimes.length > 0 ? Math.min(...createdTimes) : now;
  if (now - earliest < MIN_PERSONA_AGE_MS) {
    return { ran: false, reason: 'persona_too_young', proposalCount: 0 };
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
  const input: HygieneAnalyzeInput = {
    facts: factInputs,
    topics,
    now,
    rejectedFingerprints: rejected,
  };
  const proposals = analyzeHygiene(input);

  await writePending(proposals);
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

// ── Accept / Reject ──────────────────────────────────────────────────────────

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

  let ok = true;
  for (const op of proposal.ops) {
    try {
      if (op.type === 'delete_fact') {
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

  await writePending(pending.filter((p) => p.id !== id));
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
  await writePending(pending.filter((p) => p.id !== id));
  notifyChange();
}
