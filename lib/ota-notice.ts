// What the reader is told about an OTA update: a notified toast plus an
// `update_available` inbox row once a bundle is downloaded and pending, then an
// `app_updated` row on the first launch of a new update, whose tap opens the
// release notes of every update applied since the one this device last ran.
// The inbox holds ONE update row at most: each replaces the other. Notes an
// unopened "App updated" row had are not lost: its notes start (`since`) rides
// on whichever row replaces it. Rows and markers stay on this phone; nothing
// about updates is sent anywhere.
import * as Updates from 'expo-updates';
import i18next from 'i18next';
import { AppState } from 'react-native';
import { create } from 'zustand';

import { notesSince, parseUpdateNotes, type UpdateNote } from '@/lib/algorithms/update-notes';
import {
    activeHolds,
    captureResumeSpot,
    devRestoreTestEnabled,
    markOtaRestartAttempted,
    requestRestart,
    restartContext,
    restartWouldReload,
    routeBlocksRestart,
} from '@/lib/app-restart';
import { deleteByTypes, getByTypes, markActioned, notify } from '@/lib/database/services/notification-service';
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

/**
 * The update downloaded BEFORE now and waiting to launch, or null. Local state
 * only (no network), so a return can decide at once.
 */
export function readyUpdateId(): string | null {
    const context = Updates.latestContext;
    const id = (context?.isUpdatePending ? context.downloadedManifest?.id : undefined) ?? fetchedId;
    return id && id !== Updates.updateId ? id : null;
}

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
 * Toast plus the `update_available` row, once per downloaded update id. Never
 * a reload. Only the row, with the noticed key left unset so the next return
 * that does not reload shows the toast: on a screen that can never restart
 * (PIN lock, sign-in, onboarding), where the toast's Restart would do nothing,
 * and while the app is in the background (the download finished after the
 * reader left; a toast there would go unseen).
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
        if (routeBlocksRestart() || AppState.currentState !== 'active') {
            await notify(row);
            return;
        }
        await setSetting(OTA_NOTICED_KEY, id);
        // Update toasts fade like any toast; the flight to the inbox read as the card sliding down.
        await toastManager.showNotifiedToast({ ...row, fly: false });
    } catch (err) {
        logger.captureException(err, { tags: { module: 'ota-notice', method: 'noticePendingUpdate' } });
    }
}

type LastRunning = { id: string; at: string | null };

/** The `app_updated` row this boot wrote, for the one "Mera updated" toast. */
type AppliedRow = { id: string; notes: UpdateNote[] };
let applied: Promise<AppliedRow | null> | null = null;
let announced = false;
/** After the restored screen settles, so a screen reader hears the toast once and over the right screen. */
const ANNOUNCE_DELAY_MS = 500;

/**
 * Once per boot: on the first launch of a new update id, the inbox gets ONE
 * `app_updated` row (replacing `update_available` and any older one), however
 * many updates the jump covered, with notes from the oldest unopened start. A
 * fresh marker (new install, a wipe) or an embedded launch (store build,
 * rollback) only records where this device is, and drops a waiting "Update
 * ready" row: its bundle launched or was thrown away, so its Restart is dead.
 */
export function noticeAppliedUpdate(): Promise<boolean> {
    applied = writeAppliedRow();
    return applied.then((row) => row != null);
}

async function writeAppliedRow(): Promise<AppliedRow | null> {
    let written: AppliedRow | null = null;
    try {
        const id = Updates.updateId;
        if (!id) return null;
        const raw = await getSetting(OTA_LAST_RUNNING_KEY);
        let prev: LastRunning | null = null;
        try {
            prev = raw ? (JSON.parse(raw) as LastRunning) : null;
        } catch {
            prev = null;
        }
        if (prev?.id === id) return null;
        if (prev && !Updates.isEmbeddedLaunch) {
            const since = [...(await carriedStarts()), prev.at].filter((s): s is string => !!s).sort()[0] ?? null;
            const notes = notesSince(parseUpdateNotes(process.env.EXPO_PUBLIC_OTA_NOTES), since);
            // The row first: it replaces older rows, so a crash before the marker
            // write repeats this same single row rather than adding a second one.
            const row = await notify({
                type: APP_UPDATED,
                source: SOURCE,
                title: 'notificationCenter.update.updatedTitle',
                body: 'notificationCenter.update.updatedBody',
                context: { notes, since },
                replaces: UPDATE_ROWS,
            });
            if (row) written = { id: row.id, notes };
        } else {
            await deleteByTypes([UPDATE_AVAILABLE]);
        }
        const next: LastRunning = { id, at: Updates.createdAt ? Updates.createdAt.toISOString() : null };
        await setSetting(OTA_LAST_RUNNING_KEY, JSON.stringify(next));
    } catch (err) {
        logger.captureException(err, { tags: { module: 'ota-notice', method: 'noticeAppliedUpdate' } });
    }
    return written;
}

/**
 * Once per process, after the launch gate placed the reader: on a boot that
 * an update reload ('ota' or a Restart tap) started, the "Mera updated" toast,
 * shown only when this boot wrote the `app_updated` row. The toast writes no row
 * of its own; its "See what's new" opens the notes and marks the row seen. A
 * cold launch gets the row alone. `missing` replaces it when the restored story
 * or publication no longer exists.
 */
export async function announceAppliedUpdate(missing?: 'story' | 'publication'): Promise<void> {
    if (announced) return;
    announced = true;
    try {
        const { reason } = await restartContext();
        if (reason !== 'ota' && reason !== 'update') return;
        // The dev restore test applies no real update, so it announces one with no notes.
        const row = applied ? await applied : devRestoreTestEnabled() ? { id: '', notes: [] } : null;
        if (!missing && !row) return;
        await new Promise((r) => setTimeout(r, ANNOUNCE_DELAY_MS));
        if (missing) {
            toastManager.showNoticeToast({
                fly: false,
                title: i18next.t(
                    missing === 'story' ? 'notificationCenter.update.storyGone' : 'notificationCenter.update.publicationGone',
                ),
            });
            return;
        }
        if (!row) return;
        const title = i18next.t('notificationCenter.update.updatedTitle');
        if (row.notes.length === 0) {
            toastManager.showNoticeToast({ title, body: i18next.t('notificationCenter.update.notesEmpty'), fly: false });
            return;
        }
        toastManager.showNoticeToast({
            title,
            fly: false,
            button: {
                label: i18next.t('notificationCenter.update.seeWhatsNew'),
                onPress: () => {
                    // Seen, as when the row itself is opened.
                    markActioned(row.id).catch((err) =>
                        logger.captureException(err, { tags: { module: 'ota-notice', method: 'seeWhatsNew' } }),
                    );
                    useOpenUpdateNotes.setState({ open: true, notes: row.notes });
                },
            },
        });
    } catch (err) {
        logger.captureException(err, { tags: { module: 'ota-notice', method: 'announceAppliedUpdate' } });
    }
}

/** Says why a Restart tap did nothing: typed text, a reply being written, or anything else held. */
function explainHeldTap(labels: string[]): void {
    const typed = labels.some((l) => l.startsWith('draft:'));
    const key = typed
        ? 'notificationCenter.update.heldDraft'
        : labels.includes('chat-stream')
          ? 'notificationCenter.update.heldReply'
          : 'notificationCenter.update.heldBusy';
    toastManager.showInfo(i18next.t(key));
}

/**
 * The toast's and the row's Restart: reloads and rebuilds the reader's spot as
 * it is at the tap (a tap in the inbox comes back to the inbox). A blocked
 * route does nothing and the row stays. A hard hold (typed text, a reply being
 * written, a purchase) does nothing either, and a short toast says why. Reason
 * `'update'`, never `'ota'`: the tap is made in the foreground, and the `'ota'`
 * marker's departure stamp would put the reader behind the PIN lock.
 */
export async function restartForUpdate(): Promise<void> {
    const context = Updates.latestContext;
    const fetched = fetchedId != null && fetchedId !== Updates.updateId ? fetchedId : null;
    // An old row with nothing pending: the reader already runs the latest bundle.
    if (!context?.isUpdatePending && !fetched) return;
    if (routeBlocksRestart()) return;
    const held = activeHolds('update');
    if (held.length > 0) {
        explainHeldTap(held);
        return;
    }
    const id = context?.downloadedManifest?.id ?? fetched;
    const spot = captureResumeSpot();
    if (id && restartWouldReload('update')) await markOtaRestartAttempted(id);
    await requestRestart('update', { spot });
}

export function __resetOtaNoticeForTests(): void {
    fetchedId = null;
    applied = null;
    announced = false;
}
