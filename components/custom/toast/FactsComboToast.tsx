import logger from '@/lib/logger';
import { close, isActive, show } from '@/lib/toast/toast-queue';
import { LoaderCircle } from 'lucide-react-native';
import React, { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import MeraToast from './MeraToast';
import { observeActiveComboJobCount } from './facts-combo-source';

export const FACTS_COMBO_TOAST_ID = 'facts-combo';

function FactsComboToastBody() {
    const { t } = useTranslation();
    // A CONSTANT title and body: the card announces whenever its text changes,
    // so no count or stage ever goes in either.
    return (
        <MeraToast
            tone="neutral"
            icon={LoaderCircle}
            title={t('profile.updatingAllFacts')}
            body={t('profile.pleaseWait')}
            progress
            progressTestID="facts-combo-progress"
        />
    );
}

/**
 * "Updating all facts / Please wait", shown while the combination pass has
 * `topic_combo` jobs pending or running. Mounted ONCE at the root, beside the
 * deck; renders nothing itself.
 *
 * - Persistent (`duration: null`), so ordinary toasts pass in front of it and
 *   it returns to the front once they drain.
 * - `dismissible: false`: only the pass ends it, at a count of 0.
 * - Shown on the 0 -> >0 edge only. `show()` with the same id REPLACES the card,
 *   which would re-announce the title and move it to the back, so a count
 *   going 3 -> 2 -> 1 must change nothing.
 * - Driven by the database, so a relaunch mid-pass shows it again.
 */
export default function FactsComboToast() {
    useEffect(() => {
        const subscription = observeActiveComboJobCount().subscribe({
            next: (count) => {
                if (count > 0 && !isActive(FACTS_COMBO_TOAST_ID)) {
                    show({
                        id: FACTS_COMBO_TOAST_ID,
                        duration: null,
                        dismissible: false,
                        render: () => <FactsComboToastBody />,
                    });
                } else if (count === 0 && isActive(FACTS_COMBO_TOAST_ID)) {
                    close(FACTS_COMBO_TOAST_ID);
                }
            },
            error: (err: unknown) => {
                logger.captureException(err, { tags: { component: 'FactsComboToast' } });
            },
        });
        return () => subscription.unsubscribe();
    }, []);
    return null;
}
