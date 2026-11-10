// The outage card's body (route1): what is paused, what still works, two ways
// to keep reading, and a "?" that explains why Mera pauses instead of
// switching to an AI that cannot keep the reader's data private. Help is a
// HelpModal (never a BottomSheet); the status link opens only once the card
// has fully gone (a browser opened on the leaving Modal is lost on iOS).

import React, { useCallback, useRef } from 'react';
import { Linking, StyleSheet, View } from 'react-native';
import { MaterialIcons } from '@expo/vector-icons';
import { useTranslation } from 'react-i18next';
import { HelpModal } from '@/components/ui/help-modal';
import { Pressable } from '@/components/ui/pressable';
import { Text } from '@/components/ui/text';
import { navigateToPage } from '@/components/custom/nav/navigate-to-page';
import { joinClauses, outageLineKeys, type OutageLane } from './card-state';
import { themedStyles, useColors } from '@/lib/theme/tokens';

const STATUS_URL = 'https://status.near.ai';
const TYPE = { fontSize: 14, lineHeight: 20 } as const;

export function OutageHelp({ lanes, onHelp }: { readonly lanes: readonly OutageLane[]; readonly onHelp: () => void }) {
    const { t, i18n } = useTranslation();
    const colors = useColors();
    const styles = useStyles();
    const paused = outageLineKeys(lanes).map((k) => t(`feed.outage.${k}`));

    const pill = (label: string, onPress: () => void, testID: string) => (
        <Pressable onPress={onPress} accessibilityRole="button" accessibilityLabel={label} testID={testID} style={styles.pillFrame}>
            <View style={styles.pill}>
                <Text style={[TYPE, { color: colors.ink, fontWeight: '600' }]}>{label}</Text>
            </View>
        </Pressable>
    );

    return (
        <View style={styles.block} testID="feed-outage-block">
            <View style={styles.row}>
                <View style={styles.lines}>
                    <Text style={[TYPE, { color: colors.ink }]} testID="feed-outage-paused">
                        {`${t('feed.outage.pausedLabel')}: ${joinClauses([paused.join(', ')], i18n.language)}`}
                    </Text>
                    <Text style={[TYPE, { color: colors.ink }]} testID="feed-outage-working">
                        {`${t('feed.outage.workingLabel')}: ${t('feed.outage.working')}`}
                    </Text>
                </View>
                {/* Its own 44pt frame, in flow beside the lines: no negative margins, so the
                    frame is never pulled under a neighbour or past the block's clip. */}
                <Pressable
                    onPress={onHelp}
                    accessibilityRole="button"
                    accessibilityLabel={t('feed.outage.helpA11y')}
                    testID="feed-outage-help"
                    style={styles.helpFrame}
                >
                    <MaterialIcons name="help-outline" size={22} color={colors.ink} />
                </Pressable>
            </View>
            <View style={styles.pills}>
                {pill(t('feed.outage.followedStories'), () => navigateToPage('stories'), 'feed-outage-followed')}
                {pill(t('feed.outage.world'), () => navigateToPage('world'), 'feed-outage-world')}
            </View>
        </View>
    );
}

/** The why, mounted by the card OUTSIDE its glass panel and its pressables (never inside the block). */
export function OutageHelpModal({ open, onClose }: { readonly open: boolean; readonly onClose: () => void }) {
    const { t } = useTranslation();
    const colors = useColors();
    const styles = useStyles();
    const openStatusAfter = useRef(false);
    const onClosed = useCallback(() => {
        if (!openStatusAfter.current) return;
        openStatusAfter.current = false;
        void Linking.openURL(STATUS_URL).catch(() => undefined);
    }, []);
    return (
        <HelpModal open={open} onClose={onClose} onClosed={onClosed} title={t('feed.outage.helpTitle')} testID="feed-outage-help-modal">
            <View style={styles.helpBody}>
                <Text style={[TYPE, { color: colors.ink }]}>{t('feed.outage.helpBody')}</Text>
                <Text style={[TYPE, { color: colors.ink }]}>{t('feed.outage.helpWorking')}</Text>
                <Text style={[TYPE, { color: colors.ink }]}>{t('feed.outage.helpBack')}</Text>
                <Pressable
                    accessibilityRole="link"
                    accessibilityLabel={t('feed.outage.helpStatus')}
                    testID="feed-outage-status-link"
                    style={styles.linkFrame}
                    onPress={() => {
                        openStatusAfter.current = true;
                        onClose();
                    }}
                >
                    <Text style={[TYPE, { color: colors.accentText, fontWeight: '600' }]}>{t('feed.outage.helpStatus')}</Text>
                </Pressable>
                <Pressable
                    accessibilityRole="button"
                    accessibilityLabel={t('common.done')}
                    testID="feed-outage-help-done"
                    style={styles.linkFrame}
                    onPress={onClose}
                >
                    <Text style={[TYPE, { color: colors.ink, fontWeight: '600' }]}>{t('common.done')}</Text>
                </Pressable>
            </View>
        </HelpModal>
    );
}

const useStyles = themedStyles((c) =>
    StyleSheet.create({
        block: { gap: 12 },
        row: { flexDirection: 'row', alignItems: 'center', gap: 8 },
        lines: { flex: 1, gap: 4 },
        pills: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
                helpFrame: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
        linkFrame: { minHeight: 44, justifyContent: 'center' },
        pillFrame: { minHeight: 44, justifyContent: 'center', marginVertical: -7 },
        pill: { borderColor: c.ink, borderWidth: 1, borderRadius: 999, paddingHorizontal: 12, paddingVertical: 4 },
        helpBody: { gap: 12 },
    }),
);
