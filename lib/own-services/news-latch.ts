import { create } from 'zustand';

// Operations the own server rejected as unknown (validation failure), for this session only.
const latched = new Set<string>();

export const latchUnsupported = (op: string): void => {
    latched.add(op);
};
export const isLatched = (op: string): boolean => latched.has(op);
export const latchedOperations = (): ReadonlySet<string> => new Set(latched);
export const clearLatch = (): void => latched.clear();

export type OwnNewsHealthValue = 'ok' | 'unreachable' | 'refused';

/** What the last own-server response said, for the feed's status line. */
export const useOwnNewsHealth = create<{ health: OwnNewsHealthValue | null }>(() => ({ health: null }));
