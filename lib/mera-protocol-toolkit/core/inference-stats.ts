// In-memory speed figures for the on-device models, shown in Mera Protocol
// settings.
//
// Deliberately NEVER persisted and never sent anywhere (invariant 9: no
// behavioural instrumentation). These are properties of the device and the
// models, measured from calls the app already makes, and they die with the
// process. A restart (a pending OTA applied on a foreground return) clears them.
//
// The two models swap in and out of memory during a sync, so load times are
// kept per role and a swap never clears a reading.

import { useSyncExternalStore } from 'react';
import type { ModelRole } from './model-catalog';

/** Which caller a call belongs to. Unlabelled calls count only toward tok/s. */
export type InferenceLabel = 'relevance' | 'reason';

type Average = { count: number; totalMs: number };

export type InferenceStats = {
  /** Most recent load time per model role. */
  loadMs: Record<ModelRole, number | null>;
  /** Prefill speed of the most recent text completion. */
  promptTokPerSec: number | null;
  /** Generation speed of the most recent text completion. */
  genTokPerSec: number | null;
  /** Kev `decide()` calls, one per article. */
  relevance: Average;
  /** Text-model note (reason) completions. */
  reason: Average;
};

const EMPTY: InferenceStats = {
  loadMs: { text: null, relevance: null },
  promptTokPerSec: null,
  genTokPerSec: null,
  relevance: { count: 0, totalMs: 0 },
  reason: { count: 0, totalMs: 0 },
};

let stats: InferenceStats = EMPTY;
const listeners = new Set<() => void>();

function emit(next: InferenceStats): void {
  stats = next;
  listeners.forEach((l) => l());
}

export function getInferenceStats(): InferenceStats {
  return stats;
}

export function resetInferenceStats(): void {
  emit(EMPTY);
}

/** True once any figure has been measured this process. */
export function hasAnyStat(s: InferenceStats): boolean {
  return (
    s.loadMs.text != null ||
    s.loadMs.relevance != null ||
    s.genTokPerSec != null ||
    s.relevance.count > 0 ||
    s.reason.count > 0
  );
}

/** Called once a model has loaded. Keeps every other figure. */
export function recordModelLoad(role: ModelRole, loadMs: number): void {
  emit({ ...stats, loadMs: { ...stats.loadMs, [role]: Math.round(loadMs) } });
}

export function recordCompletion(input: {
  label?: InferenceLabel;
  latencyMs: number;
  promptTokPerSec?: number;
  genTokPerSec?: number;
}): void {
  const next: InferenceStats = { ...stats };
  if (input.promptTokPerSec && Number.isFinite(input.promptTokPerSec)) {
    next.promptTokPerSec = Math.round(input.promptTokPerSec);
  }
  if (input.genTokPerSec && Number.isFinite(input.genTokPerSec)) {
    next.genTokPerSec = Math.round(input.genTokPerSec);
  }
  if (input.label && Number.isFinite(input.latencyMs) && input.latencyMs >= 0) {
    const prev = stats[input.label];
    next[input.label] = { count: prev.count + 1, totalMs: prev.totalMs + input.latencyMs };
  }
  emit(next);
}

/** Average milliseconds per call for `label`, or null before the first call. */
export function averageMs(avg: Average): number | null {
  return avg.count > 0 ? Math.round(avg.totalMs / avg.count) : null;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function useInferenceStats(): InferenceStats {
  return useSyncExternalStore(subscribe, getInferenceStats, getInferenceStats);
}
