// Tracks the notification bell's on-screen center in a module variable so
// non-React code (the toast-manager singleton) can read it and fly the
// "notified" toast toward the bell. Mirrors the simple singleton style of
// lib/nav-state.ts — set by NotificationBellOverlay on layout, read by the
// toast manager at show time.

export interface BellAnchor {
  x: number;
  y: number;
}

let currentAnchor: BellAnchor | null = null;

/** Registers (or clears) the bell's on-screen center. */
export function setBellAnchor(anchor: BellAnchor | null): void {
  currentAnchor = anchor;
}

/** Returns the last-registered bell center, or null if unknown. */
export function getBellAnchor(): BellAnchor | null {
  return currentAnchor;
}
