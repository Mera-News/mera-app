// capture-and-share — rasterise the stats card and hand it to the OS share
// sheet. Everything specific to `react-native-view-shot` and `expo-sharing`
// lives here so the screen stays a screen.
//
// Three facts from the P0 spike, all measured on a device rather than read off
// an option name, and all load-bearing:
//
//   1. `width`/`height` are POINTS, multiplied by the device pixel ratio on the
//      way out. A 1080 x 1920 request on a 3x device returned a 3240 x 5760
//      PNG. So the caller passes the HOST's point size and gets the export size.
//      There is no second chance at this: `expo-image-manipulator` is not
//      installed, so nothing can resize the result afterwards.
//   2. The returned URI can be a BARE absolute path with no `file://` scheme.
//      Every consumer here normalises before use.
//   3. An offscreen host must stay laid out to be captured. `display: none` and
//      unmounted trees capture as nothing. That is the screen's job, not this
//      module's, but it is the other half of the same contract.
//
// `expo-sharing` is used as its autolinked RUNTIME module only. Its config
// plugin is deliberately absent from app.json: that plugin builds an INBOUND
// share extension, which would mean an app-group entitlement and an Xcode
// target, and `shareAsync` needs none of it.

import type { View } from 'react-native';

// NOTHING NATIVE IS IMPORTED AT MODULE SCOPE IN THIS FILE.
//
// Expo Router eagerly imports every route file and everything below it at JS
// boot, so a module-scope `import ... from 'expo-sharing'` here is evaluated
// before the app has rendered anything. On a client whose BINARY lacks the
// native module, that throws `Cannot find native module 'ExpoSharing'` during
// boot and takes the WHOLE APP DOWN, not just this screen. It happened: the
// Android harness emulator's dev client was built 2026-08-14, three days before
// the commit that banked these modules, and it crashed at boot with exactly
// that.
//
// The three modules are confirmed present in the 1.3.1 production binary, so
// this is not a fix for a shipping bug. It is a fix for the BLAST RADIUS: a
// share card is the least important thing in the app and must never be able to
// stop it starting. Any older client, any future binary that drops a module,
// and any dev client built before a dependency lands now loses the share
// action and nothing else.
//
// The imports therefore live inside the action, and a failure to resolve them
// is reported as `unavailable`, the same state as a device with no share sheet.
// Keep the route file and the screen free of native imports at module scope
// too; `share-stats-route-safety.test.ts` fails if this regresses.

/** The share sheet shows this, so it is a name a human reads, not a uuid. */
const CARD_FILENAME = 'mera-reading-stats.png';

export type ShareStatsResult =
  | { status: 'shared' }
  | { status: 'unavailable' }
  | { status: 'failed'; error: unknown };

/** `captureRef` has returned a bare path rather than a `file://` URI. Anything
 *  that loads or shares the result needs the scheme. */
export function toFileUri(uri: string): string {
  if (uri.startsWith('file://')) return uri;
  return `file://${uri}`;
}

/** Best-effort removal of a previous card. Nothing captured is retained past
 *  the share flow: the PNG never reaches WatermelonDB, a cache the app reads
 *  back, or any sync. A failure here is not worth surfacing.
 *
 *  Typed structurally rather than as `File`, because naming that type would
 *  reintroduce the module-scope import this file exists to avoid. */
function removeIfPresent(file: { exists: boolean; delete: () => void }): void {
  try {
    if (file.exists) file.delete();
  } catch {
    // Cache eviction, a partially written file, a platform that refuses the
    // delete: none of it changes what the user sees.
  }
}

export interface CaptureAndShareOptions {
  /** The OFFSCREEN host, laid out at its full point size. */
  ref: React.RefObject<View | null>;
  /** The host's point size. Multiplied by the device scale on the way out, so
   *  this is what lands on the export dimensions. */
  hostWidth: number;
  hostHeight: number;
  dialogTitle: string;
}

/**
 * Captures, writes to the cache directory, and shares. Returns a result rather
 * than throwing: the house convention is that a feature says why it cannot run,
 * and never silently does nothing.
 */
export async function captureAndShare({
  ref,
  hostWidth,
  hostHeight,
  dialogTitle,
}: CaptureAndShareOptions): Promise<ShareStatsResult> {
  let Sharing: typeof import('expo-sharing');
  let Haptics: typeof import('expo-haptics');
  let File: typeof import('expo-file-system').File;
  let Paths: typeof import('expo-file-system').Paths;
  let captureRef: typeof import('react-native-view-shot').captureRef;

  try {
    // Resolved HERE, on the user's tap, never at import time. A client whose
    // binary lacks one of these throws on evaluation, and catching it costs the
    // share button rather than the app.
    [Sharing, Haptics, { File, Paths }, { captureRef }] = await Promise.all([
      import('expo-sharing'),
      import('expo-haptics'),
      import('expo-file-system'),
      import('react-native-view-shot'),
    ]);
  } catch {
    // A missing native module IS unavailability, so the user gets the inline
    // "sharing is not available" line rather than a generic failure.
    return { status: 'unavailable' };
  }

  try {
    // Gate BEFORE capturing. Rasterising a card nobody can share is work the
    // user waits for and never sees the point of.
    const available = await Sharing.isAvailableAsync();
    if (!available) return { status: 'unavailable' };

    const raw = await captureRef(ref as never, {
      width: hostWidth,
      height: hostHeight,
      format: 'png',
      result: 'tmpfile',
    });

    const destination = new File(Paths.cache, CARD_FILENAME);
    removeIfPresent(destination);
    new File(toFileUri(String(raw))).copy(destination);

    await Sharing.shareAsync(destination.uri, {
      mimeType: 'image/png',
      // iOS wants a UTI as well as a MIME type, or some targets refuse the
      // item even though the extension is right.
      UTI: 'public.png',
      dialogTitle,
    });

    void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});

    // The sheet has been dismissed by the time this resolves, so the receiving
    // app has already taken its copy.
    removeIfPresent(destination);

    return { status: 'shared' };
  } catch (error) {
    return { status: 'failed', error };
  }
}
