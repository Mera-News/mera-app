import {
    revertSourcePrefChange,
    setSourcePrefFromUi,
} from '@/lib/database/services/publication-pref-ui-actions';
import { toastManager } from '@/lib/toast-manager';
import type { TFunction } from 'i18next';

/**
 * Not preferred for ONE publication, under every name, with the app's Undo
 * toast. The toast shows before any purge: the row is written, the purge waits
 * for the card to leave, and Undo inside that window costs no rescoring.
 * False when the write was refused; anything it had written is taken back, so
 * the publication is never left hidden under part of its names.
 */
export async function setNotPreferredWithUndo(names: readonly string[], shownAs: string, t: TFunction): Promise<boolean> {
    const res = await setSourcePrefFromUi({ kind: 'publisher', names }, 'muted');
    if (!res.applied) {
        await revertSourcePrefChange(res);
        return false;
    }
    const title = t('articleMenu.notPreferredDone', { publisher: shownAs });
    // Already hidden: nothing was written, so Undo would undo nothing.
    if (!res.changeLogIds?.length) {
        toastManager.showInfo(title);
        return true;
    }
    toastManager.showUndoToast({
        title,
        undoLabel: t('articleMenu.undo'),
        undoTestID: 'publication-hide-undo',
        undoneTitle: t('feedbackTree.undoneTitle'),
        onUndo: () => revertSourcePrefChange(res),
        onClosed: res.commitPurge,
    });
    return true;
}
