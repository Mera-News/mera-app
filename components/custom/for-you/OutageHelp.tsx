// The outage card's body (route1): what is paused, what still works, two ways
// to keep reading, and a "?" that explains why Mera pauses instead of
// switching to an AI that cannot keep the reader's data private. Help is a
// HelpModal (never a BottomSheet); the status link opens only once the card
// has fully gone (a browser opened on the leaving Modal is lost on iOS).

import React, { useCallback, useRef, useState } from 'react';
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

export function OutageHelp({ lanes }: { readonly lanes: readonly OutageLane[] }) {
    const { t, i18n } = useTranslation();
    const colors = useColors();
    const styles = useStyles();
    const [helpOpen, setHelpOpen] = useState(false);
    const openStatusAfter = useRef(false);
    const paused = outageLineKeys(lanes).map((k) => t(`feed.outage.${k}`));
    const closeHelp = useCallback(() => setHelpOpen(false), []);
    const onClosed = useCallback(() => {
        if (!openStatusAfter.current) return;
        openStatusAfter.current = false;
        void Linking.openURL(STATUS_URL).catch(() => undefined);
    }, []);

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
                <Pressable
                    onPress={() => setHelpOpen(true)}
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
            <HelpModal
                open={helpOpen}
                onClose={closeHelp}
                onClosed={onClosed}
                title={t('feed.outage.helpTitle')}
                testID="feed-outage-help-modal"
            >
                <View style={styles.helpBody}>
                    <Text style={[TYPE, { color: colors.ink }]}>{t('feed.outage.helpBody')}</Text>
                    <Text style={[TYPE, { color: colors.ink }]}>{t('feed.outage.helpWorking')}</Text>
                    <Text style={[TYPE, { color: colors.ink }]}>{t('feed.outage.helpBack')}</Text>
                    <Pressable
                        accessibilityRole="link"
                        accessibilityLabel={t('feed.outage.helpStatus')}
                        testID="feed-outage-status-link"
                        style={styles.helpFrame}
                        onPress={() => {
                            openStatusAfter.current = true;
                            setHelpOpen(false);
                        }}
                    >
                        <Text style={[TYPE, { color: colors.accentText, fontWeight: '600' }]}>{t('feed.outage.helpStatus')}</Text>
                    </Pressable>
                    <Pressable
                        accessibilityRole="button"
                        accessibilityLabel={t('common.done')}
                        testID="feed-outage-help-done"
                        style={styles.helpFrame}
                        onPress={closeHelp}
                    >
                        <Text style={[TYPE, { color: colors.ink, fontWeight: '600' }]}>{t('common.done')}</Text>
                    </Pressable>
                </View>
            </HelpModal>
        </View>
    );
}

const useStyles = themedStyles((c) =>
    StyleSheet.create({
        block: { gap: 12 },
        row: { flexDirection: 'row', alignItems: 'flex-start', gap: 8 },
        lines: { flex: 1, gap: 4 },
        pills: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
        // A 44pt frame (never hitSlop), margins given back so the row keeps its height.
        helpFrame: { minWidth: 44, minHeight: 44, alignItems: 'center', justifyContent: 'center', marginVertical: -12, marginRight: -10 },
        pillFrame: { minHeight: 44, justifyContent: 'center', marginVertical: -7 },
        pill: { borderColor: c.ink, borderWidth: 1, borderRadius: 999, paddingHorizontal: 12, paddingVertical: 4 },
        helpBody: { gap: 12 },
    }),
);
