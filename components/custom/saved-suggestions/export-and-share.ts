// export-and-share — write an export (saved articles, or a followed story) to a file and hand it to
// the OS share sheet. Everything specific to `expo-sharing` and
// `expo-file-system` lives here so the wizard stays a wizard.
//
// Built on the same recipe as `share-stats/capture-and-share.ts`, for the same
// measured reasons. Read that file's header before changing this one.

import { Share } from 'react-native';

// NOTHING NATIVE IS IMPORTED AT MODULE SCOPE IN THIS FILE.
//
// Expo Router eagerly imports every route file and everything below it at JS
// boot, so a module-scope `import ... from 'expo-sharing'` here is evaluated
// before the app has rendered anything. On a client whose BINARY lacks the
// native module that throws `Cannot find native module 'ExpoSharing'` during
// boot and takes the WHOLE APP DOWN, not just this screen. It has happened
// once already, on an Android harness dev client built three days before the
// commit that banked the module.
//
// `expo-sharing` is banked in the production binary (baff527), so this is not
// a fix for a shipping bug. It is a fix for the BLAST RADIUS: exporting a list
// of saved articles is the least important thing in the app and must never be
// able to stop it starting.
//
// `expo-file-system` has a second reason: it is not a direct dependency at all
// and never has been. It arrives transitively through `expo`, so its presence
// is a property of whatever `npm ci` resolved rather than of package.json.
//
// `saved-export-route-safety.test.ts` fails if this regresses. `react-native`'s
// own `Share` is core, always present, and is the fallback below.

/** The share sheet shows the file name, so it is a name a human reads. Each
 *  caller names its own export; the Saved tab keeps the original. */
const DEFAULT_FILE_BASE_NAME = 'mera-saved-articles';
const EXTENSION = { markdown: 'md', json: 'json' } as const;

/** iOS wants a UTI as well as a MIME type, or some targets refuse the item
 *  even though the extension is right. */
const TYPES = {
  markdown: { mimeType: 'text/markdown', UTI: 'net.daringfireball.markdown' },
  json: { mimeType: 'application/json', UTI: 'public.json' },
} as const;

export type ExportFormat = keyof typeof EXTENSION;

export type ExportShareResult =
  | { status: 'shared'; via: 'file' | 'text' }
  | { status: 'failed'; error: unknown };

/** A returned path can be bare rather than a `file://` URI. Anything that
 *  loads or shares a result needs the scheme. */
export function toFileUri(uri: string): string {
  if (uri.startsWith('file://')) return uri;
  return `file://${uri}`;
}

/** Best-effort removal of a previous export. Nothing written here is retained
 *  past the share flow: the file never reaches WatermelonDB, a cache the app
 *  reads back, or any sync. A failure here is not worth surfacing.
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

export interface ExportAndShareOptions {
  /** The finished document, already serialised by `lib/saved-articles-export`. */
  content: string;
  format: ExportFormat;
  dialogTitle: string;
  /** File name without extension. Defaults to the Saved tab's. */
  fileBaseName?: string;
}

/**
 * Shares the export as a FILE, falling back to sharing it as text.
 *
 * The fallback is DEGRADED and is not a second-class implementation of the
 * same thing: it puts the whole document inline as share text, which for a
 * long saved list is a wall of text rather than something you can save to
 * Files. It exists because the alternative is a dead end. `Share.share` is
 * core React Native, so it cannot fail to resolve, which makes it the right
 * answer for a dev client built before `expo-sharing` was banked and for a
 * platform whose share sheet refuses files. Never promote it to the primary.
 *
 * Returns a result rather than throwing: the house convention is that a
 * feature says why it could not run, and never silently does nothing.
 */
/**
 * Writes the export to the cache directory and shares it as a FILE. Returns
 * false for every reason the file path can be unavailable — a missing native
 * module, a share sheet that refuses, a failed write — so the caller has one
 * branch rather than three.
 */
async function shareAsFile(
  content: string,
  format: ExportFormat,
  dialogTitle: string,
  fileBaseName: string,
): Promise<boolean> {
  let Sharing: typeof import('expo-sharing');
  let Haptics: typeof import('expo-haptics');
  let File: typeof import('expo-file-system').File;
  let Paths: typeof import('expo-file-system').Paths;

  try {
    // Resolved HERE, on the user's tap, never at import time. A client whose
    // binary lacks one of these throws on evaluation, and catching it costs
    // the file path rather than the app.
    [Sharing, Haptics, { File, Paths }] = await Promise.all([
      import('expo-sharing'),
      import('expo-haptics'),
      import('expo-file-system'),
    ]);
  } catch {
    return false;
  }

  try {
    // Gate BEFORE writing. A file nobody can share is a file left in the
    // cache for nothing.
    if (!(await Sharing.isAvailableAsync())) return false;

    const destination = new File(Paths.cache, `${fileBaseName}.${EXTENSION[format]}`);
    removeIfPresent(destination);
    destination.create();
    destination.write(content);

    await Sharing.shareAsync(toFileUri(destination.uri), {
      ...TYPES[format],
      dialogTitle,
    });

    void Haptics.notificationAsync(
      Haptics.NotificationFeedbackType.Success,
    ).catch(() => {});

    // The sheet has been dismissed by the time this resolves, so the receiving
    // app has already taken its copy.
    removeIfPresent(destination);

    return true;
  } catch {
    // A write or a share that failed on the file path is exactly the case the
    // text fallback is for. A reader who gets their export as text is better
    // served than one who gets an error toast.
    return false;
  }
}

export async function exportAndShare({
  content,
  format,
  dialogTitle,
  fileBaseName = DEFAULT_FILE_BASE_NAME,
}: ExportAndShareOptions): Promise<ExportShareResult> {
  if (await shareAsFile(content, format, dialogTitle, fileBaseName)) {
    return { status: 'shared', via: 'file' };
  }

  try {
    await Share.share({ message: content }, { subject: dialogTitle });
    return { status: 'shared', via: 'text' };
  } catch (error) {
    return { status: 'failed', error };
  }
}
