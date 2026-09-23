// In-memory speed figures for the on-device model, shown in Mera Protocol
// settings so two models can be compared on the same phone.
//
// Deliberately NEVER persisted and never sent anywhere (invariant 9: no
// behavioural instrumentation). These are properties of the device and the
// model, measured from calls the app already makes, and they die with the
// process. Every return from background restarts the app, so a reading survives
// only until the user leaves it.

import { useSyncExternalStore } from 'react';

/** Which caller a completion belongs to. Unlabelled calls count only toward tok/s. */
export type InferenceLabel = 'relevance' | 'reason';

type Average = { count: number; totalMs: number };

export type InferenceStats = {
  modelId: string | null;
  loadMs: number | null;
  /** Prefill speed of the most recent completion. */
  promptTokPerSec: number | null;
  /** Generation speed of the most recent completion. */
  genTokPerSec: number | null;
  relevance: Average;
  reason: Average;
};

const EMPTY: InferenceStats = {
  modelId: null,
  loadMs: null,
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

/** Called once a model has loaded. A different model starts a fresh reading. */
export function recordModelLoad(modelId: string, loadMs: number): void {
  const base = stats.modelId === modelId ? stats : EMPTY;
  emit({ ...base, modelId, loadMs: Math.round(loadMs) });
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
