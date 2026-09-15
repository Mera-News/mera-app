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

import * as Haptics from 'expo-haptics';
import { File, Paths } from 'expo-file-system';
import * as Sharing from 'expo-sharing';
import { captureRef } from 'react-native-view-shot';
import type { View } from 'react-native';

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
 *  back, or any sync. A failure here is not worth surfacing. */
function removeIfPresent(file: File): void {
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
