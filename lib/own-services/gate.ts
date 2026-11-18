import { ProcessingMode } from '@/lib/generated/graphql-types';

export class OwnServiceError extends Error {
  constructor(
    readonly code: 'address' | 'not-checked' | 'gate' | 'on-device' | 'not-confirmed',
    readonly reason?: string,
  ) {
    super(reason ? `${code}: ${reason}` : code);
    this.name = 'OwnServiceError';
  }
}

/** When the person pressed the confirm's affirmative button, and the privacy policy version they had accepted. */
export type Confirmation = { at: number; privacyVersion: string | null };

/** A stored confirmation, or null for anything else: a mode is on only with one. */
export function parseConfirmation(raw: unknown): Confirmation | null {
  const c = raw as Partial<Confirmation> | null | undefined;
  if (!c || typeof c.at !== 'number') return null;
  return { at: c.at, privacyVersion: typeof c.privacyVersion === 'string' ? c.privacyVersion : null };
}

// The owner's subscription rule goes here; a mode that is already on stays on when this turns false.
export function ownServicesAllowed(): boolean {
  return true;
}

// Every own mode turns on only after a passing check, when allowed, and never next to on-device.
export function guardTurnOn(status: string | null | undefined): void {
  if (status !== 'connected') throw new OwnServiceError('not-checked');
  if (!ownServicesAllowed()) throw new OwnServiceError('gate');
  // Lazy: the store reaches the database, which opens SQLite at import, and the Apollo client imports this file.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { useMeraProtocolStore } = require('@/lib/stores/mera-protocol-store') as typeof import('@/lib/stores/mera-protocol-store');
  if (useMeraProtocolStore.getState().processingMode === ProcessingMode.OnDevice) throw new OwnServiceError('on-device');
}
