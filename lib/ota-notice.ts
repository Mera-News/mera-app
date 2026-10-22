// What the reader is told about an OTA update: a notified toast plus an
// `update_available` inbox row once a bundle is downloaded and pending, then an
// `app_updated` row on the first launch of a new update, whose tap opens the
// release notes of every update applied since the one this device last ran.
// The inbox holds ONE update row at most: each replaces the other. Notes an
// unopened "App updated" row had are not lost: its notes start (`since`) rides
// on whichever row replaces it. Rows and markers stay on this phone; nothing
// about updates is sent anywhere.
import * as Updates from 'expo-updates';
import { create } from 'zustand';

import { notesSince, parseUpdateNotes, type UpdateNote } from '@/lib/algorithms/update-notes';
import { markOtaRestartAttempted, requestRestart, restartWouldReload, routeBlocksRestart } from '@/lib/app-restart';
import { deleteByTypes, getByTypes, notify } from '@/lib/database/services/notification-service';
import { getSetting, setSetting } from '@/lib/database/services/setting-service';
import logger from '@/lib/logger';
import { toastManager } from '@/lib/toast-manager';

export const UPDATE_AVAILABLE = 'update_available';
export const APP_UPDATED = 'app_updated';
export const RESTART_FOR_UPDATE = 'restart-for-update';
const SOURCE = 'ota';
const UPDATE_ROWS = [UPDATE_AVAILABLE, APP_UPDATED];

/** The pending update id already announced, so the toast shows once per id. */
export const OTA_NOTICED_KEY = 'ota_update_noticed_id';
/** `{id, at}` of the update this device last ran (`at` is its createdAt ISO, or null). */
export const OTA_LAST_RUNNING_KEY = 'ota_last_running_update';

/** The notes the open "What's new" card shows; `open` false keeps them for the card's exit. */
export const useOpenUpdateNotes = create<{ open: boolean; notes: UpdateNote[] }>(() => ({ open: false, notes: [] }));

/** The update this session downloaded: `latestContext` reports it pending only after a later native event. */
let fetchedId: string | null = null;

/** The notes starts the update rows still carry: a waiting "Update ready" row's, an unopened "App updated" row's. */
async function carriedStarts(): Promise<string[]> {
    const rows = await getByTypes(UPDATE_ROWS);
    return rows
        .filter((r) => r.type === UPDATE_AVAILABLE || r.status !== 'actioned')
        .map((r) => {
            try {
                const since = (JSON.parse(r.contextJson ?? 'null') as { since?: unknown } | null)?.since;
                return typeof since === 'string' ? since : null;
            } catch {
                return null;
            }
        })
        .filter((s): s is string => s != null);
}

/**
 * Toast plus the `update_available` row, once per downloaded update id. On a
 * screen that can never restart (PIN lock, sign-in, onboarding) only the row:
 * the toast's Restart would do nothing there, so it waits for a later return.
 */
export async function noticePendingUpdate(id: string): Promise<void> {
    try {
        if (id === Updates.updateId) return;
        fetchedId = id;
        if ((await getSetting(OTA_NOTICED_KEY)) === id) return;
        const since = (await carriedStarts()).sort()[0];
        const row = {
            type: UPDATE_AVAILABLE,
            source: SOURCE,
            title: 'notificationCenter.update.availableTitle',
            body: 'notificationCenter.update.availableBody',
            actions: [{ id: RESTART_FOR_UPDATE, labelKey: 'notificationCenter.update.restart' }],
            context: since ? { since } : undefined,
            replaces: UPDATE_ROWS,
        };
        if (routeBlocksRestart()) {
            await notify(row);
            return;
        }
        await setSetting(OTA_NOTICED_KEY, id);
        await toastManager.showNotifiedToast(row);
    } catch (err) {
        logger.captureException(err, { tags: { module: 'ota-notice', method: 'noticePendingUpdate' } });
    }
}

type LastRunning = { id: string; at: string | null };

/**
 * Once per boot: on the first launch of a new update id, the inbox gets ONE
 * `app_updated` row (replacing `update_available` and any older one), however
 * many updates the jump covered, with notes from the oldest unopened start. A
 * fresh marker (new install, a wipe) or an embedded launch (store build,
 * rollback) only records where this device is, and drops a waiting "Update
 * ready" row: its bundle launched or was thrown away, so its Restart is dead.
 */
export async function noticeAppliedUpdate(): Promise<void> {
    try {
        const id = Updates.updateId;
        if (!id) return;
        const raw = await getSetting(OTA_LAST_RUNNING_KEY);
        let prev: LastRunning | null = null;
        try {
            prev = raw ? (JSON.parse(raw) as LastRunning) : null;
        } catch {
            prev = null;
        }
        if (prev?.id === id) return;
        if (prev && !Updates.isEmbeddedLaunch) {
            const since = [...(await carriedStarts()), prev.at].filter((s): s is string => !!s).sort()[0] ?? null;
            // The row first: it replaces older rows, so a crash before the marker
            // write repeats this same single row rather than adding a second one.
            await notify({
                type: APP_UPDATED,
                source: SOURCE,
                title: 'notificationCenter.update.updatedTitle',
                body: 'notificationCenter.update.updatedBody',
                context: { notes: notesSince(parseUpdateNotes(process.env.EXPO_PUBLIC_OTA_NOTES), since), since },
                replaces: UPDATE_ROWS,
            });
        } else {
            await deleteByTypes([UPDATE_AVAILABLE]);
        }
        const next: LastRunning = { id, at: Updates.createdAt ? Updates.createdAt.toISOString() : null };
        await setSetting(OTA_LAST_RUNNING_KEY, JSON.stringify(next));
    } catch (err) {
        logger.captureException(err, { tags: { module: 'ota-notice', method: 'noticeAppliedUpdate' } });
    }
}

/**
 * The toast's and the row's Restart. Holds and blocked routes still apply; a
 * blocked tap does nothing more and the row stays. Reason `'update'`, never
 * `'ota'`: the tap is made in the foreground, and the `'ota'` marker's departure
 * stamp would put the reader behind the PIN lock on the reload.
 */
export async function restartForUpdate(): Promise<void> {
    const context = Updates.latestContext;
    const fetched = fetchedId != null && fetchedId !== Updates.updateId ? fetchedId : null;
    // An old row with nothing pending: the reader already runs the latest bundle.
    if (!context?.isUpdatePending && !fetched) return;
    const id = context?.downloadedManifest?.id ?? fetched;
    if (id && restartWouldReload()) await markOtaRestartAttempted(id);
    await requestRestart('update');
}

export function __resetOtaNoticeForTests(): void {
    fetchedId = null;
}
