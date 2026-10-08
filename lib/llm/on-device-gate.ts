// ON-DEVICE MODE NEVER CALLS THE CLOUD AI (owner decision).
//
// The gate sits at the cloud entry points themselves (cloudComplete,
// cloudBatchComplete, cloudChatStream, prepareE2EEContext, rebuildE2EEContext),
// so a caller that forgets its own mode check cannot leak: it gets an
// OnDeviceModeError instead of a request. Callers that can decide earlier
// should ask `isOnDeviceMode()` and skip cleanly; the error is the backstop.
//
// WHY NOT JUST THE STORE. `processingMode` defaults to Cloud until
// hydrateFromDb has run, and a background wake can reach a cloud call before it
// has. So while the store says Cloud, the persisted SETTINGS row is consulted
// once; once it has said "not on-device", the store is trusted (hydration has
// by then happened, and every later change goes through setProcessingMode).
// A row that says on-device is never cached: the store may still be
// unhydrated, so the row is read again until the store agrees.
//
// Both requires are lazy: the store and the setting service build their
// collections at module scope, and cloudComplete is imported by suites that
// cannot construct a SQLiteAdapter.

export class OnDeviceModeError extends Error {
  constructor(message = 'The cloud AI is off while processing is set to on-device') {
    super(message);
    this.name = 'OnDeviceModeError';
  }
}

export function isOnDeviceModeError(err: unknown): boolean {
  return (err as { name?: unknown } | null)?.name === 'OnDeviceModeError';
}

const SETTING_PROCESSING_MODE = 'mera_processing_mode';
const ON_DEVICE = 'ON_DEVICE'; // ProcessingMode.OnDevice (not imported: keep this module light)

let persistedSaidCloud = false;

/** Test seam. */
export function __resetOnDeviceGateForTests(): void {
  persistedSaidCloud = false;
}

function storeMode(): string | null {
  try {
    const { useMeraProtocolStore } =
      require('../stores/mera-protocol-store') as typeof import('../stores/mera-protocol-store');
    return useMeraProtocolStore.getState().processingMode;
  } catch {
    return null;
  }
}

/** True while the app is in on-device processing mode. */
export async function isOnDeviceMode(): Promise<boolean> {
  if (storeMode() === ON_DEVICE) return true;
  if (!persistedSaidCloud) {
    try {
      const { getSetting } =
        require('../database/services/setting-service') as typeof import('../database/services/setting-service');
      const row = await getSetting(SETTING_PROCESSING_MODE);
      if (row === ON_DEVICE) return true;
      // Absent or cloud: from here the (now hydrated) store is the authority.
      persistedSaidCloud = true;
    } catch {
      // The row is unreadable: fall through to the store's own answer.
    }
  }
  return storeMode() === ON_DEVICE;
}

/** Throws OnDeviceModeError in on-device mode. The entry points' backstop. */
export async function assertCloudAllowed(): Promise<void> {
  if (await isOnDeviceMode()) throw new OnDeviceModeError();
}
