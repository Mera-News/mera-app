// Release notes an OTA bundle carries (`EXPO_PUBLIC_OTA_NOTES`, written by
// scripts/ota-publish.js at export time): this update's message plus the recent
// ones on the same branch and runtime. The app cannot read an update's message
// at runtime, and never the messages of updates it skipped, so they travel here.

export type UpdateNote = { at: string; message: string };

/** The most notes the "What's new" card lists. */
export const MAX_UPDATE_NOTES = 10;

/** The bundle's notes, or [] when absent (a dev build) or malformed. */
export function parseUpdateNotes(raw?: string | null): UpdateNote[] {
    if (!raw) return [];
    let parsed: unknown;
    try {
        parsed = JSON.parse(raw);
    } catch {
        return [];
    }
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
        (n): n is UpdateNote =>
            !!n &&
            typeof n.at === 'string' &&
            !Number.isNaN(Date.parse(n.at)) &&
            typeof n.message === 'string' &&
            n.message.trim() !== '',
    );
}

/**
 * The notes of every update applied since the one this device last ran (strictly
 * newer than `sinceIso`), newest first, at most MAX_UPDATE_NOTES. With no known
 * last update, only the newest note.
 */
export function notesSince(notes: UpdateNote[], sinceIso: string | null): UpdateNote[] {
    const newestFirst = [...notes].sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
    if (sinceIso == null) return newestFirst.slice(0, 1);
    const since = Date.parse(sinceIso);
    return newestFirst.filter((n) => Date.parse(n.at) > since).slice(0, MAX_UPDATE_NOTES);
}
