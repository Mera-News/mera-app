// In-memory speed figures for the on-device models, shown in Mera Protocol
// settings.
//
// Deliberately NEVER persisted and never sent anywhere (invariant 9: no
// behavioural instrumentation). These are properties of the device and the
// models, measured from calls the app already makes, and they die with the
// process. A restart (a pending OTA applied on a foreground return) clears them.
//
// Kev is the only model loaded (the built-in text model runs out of process and
// reports no speed), so there is one load time.

import { useSyncExternalStore } from 'react';

/** Which caller a call belongs to. Unlabelled calls are not counted. */
export type InferenceLabel = 'relevance' | 'reason';

type Average = { count: number; totalMs: number };

export type InferenceStats = {
  /** Most recent Kev load time. */
  loadMs: number | null;
  /** Kev `decide()` calls, one per article. */
  relevance: Average;
  /** Text-model note (reason) completions. */
  reason: Average;
  /** Native-engine calls the model declined (a guardrail or a refusal). Failed calls, never crashes. */
  refused: number;
};

const EMPTY: InferenceStats = {
  loadMs: null,
  relevance: { count: 0, totalMs: 0 },
  reason: { count: 0, totalMs: 0 },
  refused: 0,
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
    s.loadMs != null ||
    s.relevance.count > 0 ||
    s.reason.count > 0 ||
    s.refused > 0
  );
}

/** A native-engine call the model declined. */
export function recordRefusal(): void {
  emit({ ...stats, refused: stats.refused + 1 });
}

/** Called once Kev has loaded. Keeps every other figure. */
export function recordModelLoad(loadMs: number): void {
  emit({ ...stats, loadMs: Math.round(loadMs) });
}

export function recordCompletion(input: { label?: InferenceLabel; latencyMs: number }): void {
  const next: InferenceStats = { ...stats };
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
