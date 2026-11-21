// The "Add to Mera News" link a publisher puts on its site:
// https://mera.news/add/<publisherId> (a universal link once the binary claims it,
// plans/ready_to_implement/native_build_plans/) and meraapp://add/<publisherId>.
// Opening it makes that publisher a preferred source, opens its page and shows an
// Undo toast. Everything happens on the device: nothing is sent or counted.
//
// A link never acts ahead of the startup gate (identity, onboarding, PIN, paywall):
// routed straight to a screen, a cold link would skip every one of them. So
// `routeAddSourceLink` holds the id and sends the router to `/`, and the gate runs
// `openPendingAddSource` once the reader is on their startup tab. With the gate
// already open (a warm app, PIN unlocked) it acts at once and routes to the page.
//
// IMPORT DISCIPLINE: +native-intent loads this at boot, so the database, the toast
// host and i18n are required at call time.

import { openPublicationPage } from '@/components/custom/publication-page/open-publication-page';
import { isStartupGatePassed } from '@/lib/stores/pending-notification-route';

// The scheme and host are optional: the router hands over `meraapp://add/<id>`,
// `https://mera.news/add/<id>` or the bare path. A publisher id is a Mongo ObjectId.
const ADD_LINK = /^(?:[a-z][\w+.-]*:\/\/)?(?:(?:www\.)?mera\.news)?\/?add\/([0-9a-f]{24})\/?(?:[?#].*)?$/;

/** The publisher id an incoming link adds, or null when it is not an add link. */
export function addSourceIdFromPath(path: string): string | null {
    return ADD_LINK.exec(path)?.[1] ?? null;
}

let pending: string | null = null;

/** Past the startup gate and the PIN unlocked: the same test a notification tap uses. */
function gateIsOpen(): boolean {
    if (!isStartupGatePassed()) return false;
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { usePinStore } = require('@/lib/stores/pin-store') as typeof import('@/lib/stores/pin-store');
    return usePinStore.getState().locked === false;
}

/** +native-intent's call: where the router goes for an add link. */
export function routeAddSourceLink(publisherId: string): string {
    if (!gateIsOpen()) {
        pending = publisherId;
        return '/';
    }
    void addSourceFromLink(publisherId, false);
    return `/logged-in/publication?publisherId=${publisherId}`;
}

/** The startup gate's call, once the reader is on their startup tab. Opens at most once. */
export async function openPendingAddSource(isCancelled: () => boolean): Promise<void> {
    const id = pending;
    pending = null;
    if (id && !isCancelled()) await addSourceFromLink(id, true);
}

/**
 * Prefer the publisher under every name it is known by, then (when `navigate`) open
 * its page. Already preferred: the page only, no toast. A failed lookup or write
 * leaves nothing half-written and says so. Never throws.
 */
export async function addSourceFromLink(publisherId: string, navigate: boolean): Promise<void> {
    /* eslint-disable @typescript-eslint/no-require-imports */
    const { toastManager } = require('@/lib/toast-manager') as typeof import('@/lib/toast-manager');
    const i18n = (require('@/lib/i18n') as typeof import('@/lib/i18n')).default;
    const prefs = require('@/lib/database/services/publication-pref-ui-actions') as typeof import('@/lib/database/services/publication-pref-ui-actions');
    const sourceNames = require('@/lib/database/services/publisher-source-names') as typeof import('@/lib/database/services/publisher-source-names');
    /* eslint-enable @typescript-eslint/no-require-imports */
    try {
        const names = await sourceNames.fetchPublicationPrefNames({ publisherId });
        const res = await prefs.setSourcePrefFromUi({ kind: 'publisher', names }, 'prioritised');
        if (!res.applied) {
            await prefs.revertSourcePrefChange(res);
            toastManager.showInfo(i18n.t('you.sources.addFromLinkFailed'));
            return;
        }
        if (navigate) openPublicationPage({ publisherId });
        if (!res.changeLogIds?.length) return;
        toastManager.showUndoToast({
            title: i18n.t('you.sources.addedFromLink'),
            undoLabel: i18n.t('articleMenu.undo'),
            undoTestID: 'add-source-undo',
            undoneTitle: i18n.t('feedbackTree.undoneTitle'),
            onUndo: () => prefs.revertSourcePrefChange(res),
        });
    } catch {
        // Offline, or the publisher is unknown to the server: nothing was written.
        toastManager.showInfo(i18n.t('you.sources.addFromLinkFailed'));
    }
}

/** Test seam: forget a held link, as a JS reload would. */
export function __resetPendingAddSourceForTests(): void {
    pending = null;
}
