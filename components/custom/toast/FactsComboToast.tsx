import { Toast, ToastDescription, ToastTitle } from '@/components/ui/toast';
import logger from '@/lib/logger';
import { close, isActive, show } from '@/lib/toast/toast-queue';
import React, { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { View } from 'react-native';
import IndeterminateBar from './IndeterminateBar';
import { observeActiveComboJobCount } from './facts-combo-source';

export const FACTS_COMBO_TOAST_ID = 'facts-combo';

/** Explicit: see `IndeterminateBar`'s width note. */
const BAR_WIDTH = 160;

function FactsComboToastBody() {
    const { t } = useTranslation();
    return (
        <Toast action="muted" variant="solid">
            {/* A CONSTANT title: `ToastTitle` announces whenever its text
                changes, so no count or stage ever goes in it. The English
                defaults cover the window before the ux2 fragment is spliced
                (lib/locales/_ux2-facts-combo-toast-fragments.json); they can
                go once both keys are in en.json. */}
            <ToastTitle>{t('profile.updatingAllFacts', { defaultValue: 'Updating all facts' })}</ToastTitle>
            <ToastDescription size="sm">{t('profile.pleaseWait', { defaultValue: 'Please wait' })}</ToastDescription>
            <View style={{ paddingTop: 6 }}>
                <IndeterminateBar width={BAR_WIDTH} testID="facts-combo-progress" />
            </View>
        </Toast>
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
