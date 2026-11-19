// One gate for everything a launch starts that is not the wake itself: the route tree (and with it
// every boot effect, SDK start and screen query) and Sentry. A process the OS starts in the
// background, for a silent push or a background task, runs its task and nothing else.
//
// Read at bundle evaluation, which happens on every launch (index.js loads this through
// lib/sentry-init before the router):
//   - `active`, or iOS's `inactive` on the way to it: a foreground start. Open at once, so a normal
//     launch starts everything exactly when it did before the gate existed.
//   - `background` or `unknown`: closed until the first `active`. An Android cold start that reports
//     `background` before its first `active` starts a few milliseconds later; accepted.
//
// Kept free of app imports: it loads before the router on every launch.

import { useSyncExternalStore } from 'react';
import { AppState } from 'react-native';

let open = false;
let held: (() => void)[] = [];
let listener: { remove: () => void } | null = null;
const subscribers = new Set<() => void>();

function openGate(): void {
    if (open) return;
    open = true;
    listener?.remove();
    listener = null;
    const steps = held;
    held = [];
    for (const step of steps) {
        try {
            step();
        } catch {
            // One held step failing must not stop the others.
        }
    }
    subscribers.forEach((notify) => notify());
}

function arm(initial: string | null | undefined): void {
    listener?.remove();
    listener = null;
    held = [];
    open = initial === 'active' || initial === 'inactive';
    if (open) return;
    listener = AppState.addEventListener('change', (state) => {
        if (state === 'active') openGate();
    });
}

arm(AppState.currentState);

export const isForegroundGateOpen = (): boolean => open;

/** Runs `step` now when the gate is open, else once when it opens. */
export function whenForegroundGateOpens(step: () => void): void {
    if (open) step();
    else held.push(step);
}

const subscribe = (notify: () => void) => {
    subscribers.add(notify);
    return () => {
        subscribers.delete(notify);
    };
};

/** True once the gate is open; re-renders the caller when it opens. */
export function useForegroundGateOpen(): boolean {
    return useSyncExternalStore(subscribe, isForegroundGateOpen);
}

/** Test-only: arm the gate again from the AppState the test has set, as a fresh launch would. */
export function resetForegroundGateForTests(): void {
    arm(AppState.currentState);
}
