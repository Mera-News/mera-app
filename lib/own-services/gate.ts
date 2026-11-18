import { ProcessingMode } from '@/lib/generated/graphql-types';

export class OwnServiceError extends Error {
  constructor(
    readonly code: 'address' | 'not-checked' | 'gate' | 'on-device',
    readonly reason?: string,
  ) {
    super(reason ? `${code}: ${reason}` : code);
    this.name = 'OwnServiceError';
  }
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
