// Shared pieces of the Library Activity page and its pushed screens (History,
// Where you read, Languages, What you opened, How fresh): the outlined Share
// pill beside a title, the opening of a Library-stack screen, and the frame
// every one of those screens draws (back, title row, intro, one list).

import DrillDownHeader from '@/components/custom/config-panel/DrillDownHeader';
import { Pressable } from '@/components/ui/pressable';
import { Text } from '@/components/ui/text';
import { getCountryName } from '@/lib/algorithms/country-utils';
import { WEBSITE_URL } from '@/lib/config/branding';
import logger from '@/lib/logger';
import { useListEndClearance } from '@/lib/navigation/tab-bar';
import { buildActivityShareText } from '@/lib/stats/activity';
import { useColors } from '@/lib/theme/tokens';
import { notifyScrollTick } from '@/lib/visibility-tick';
import { MaterialIcons } from '@expo/vector-icons';
import { router } from 'expo-router';
import type { TFunction } from 'i18next';
import React from 'react';
import { useTranslation } from 'react-i18next';
import { FlatList, type FlatListProps, Share, StyleSheet, View } from 'react-native';

const SIDE = 16;

/** The outlined Share pill (the Activity boards), 36pt drawn in a 44pt frame. */
export const SharePill: React.FC<{ readonly onPress: () => void; readonly testID: string; readonly disabled?: boolean }> = ({
    onPress,
    testID,
    disabled = false,
}) => {
    const { t } = useTranslation();
    const c = useColors();
    return (
        <Pressable
            onPress={onPress}
            disabled={disabled}
            accessibilityRole="button"
            accessibilityLabel={t('library.stats.share')}
            accessibilityState={{ disabled }}
            testID={testID}
            style={styles.pillFrame}
        >
            <View style={[styles.pill, { borderColor: c.edge, opacity: disabled ? 0.45 : 1 }]}>
                <MaterialIcons name="ios-share" size={16} color={c.ink} />
                <Text scaleTier="chrome" style={{ color: c.ink, fontSize: 14, lineHeight: 20, fontWeight: '600' }}>
                    {t('library.stats.share')}
                </Text>
            </View>
        </Pressable>
    );
};

/** A visit's country (alpha-3, or GLOBAL) as the reader reads it. */
export function countryLabel(t: TFunction, code: string): string {
    return code === 'GLOBAL' ? t('articleDetail.sourceCountryGlobal') : getCountryName(code);
}

/** Opens a screen of the Library stack on top of the current one. */
export function openLibraryScreen(
    screen: 'history' | 'where-you-read' | 'languages' | 'reading-log' | 'freshness',
    params: Record<string, string> = {},
): void {
    router.push({ pathname: `/logged-in/app_container/library/${screen}`, params });
}

/**
 * A text share through the native sheet (useShareArticle's channel): the
 * heading, the lines, then "Shared via" and "Counted on my phone".
 */
export async function shareActivityText(t: TFunction, heading: string, lines: readonly string[]): Promise<void> {
    try {
        const message = buildActivityShareText(
            heading,
            lines,
            t('articleDetail.shareVia', { downloadUrl: WEBSITE_URL }),
            t('shareStats.card.privacyMine'),
        );
        await Share.share({ message }, { subject: heading });
    } catch (err) {
        logger.captureException(err, { tags: { component: 'activity', method: 'shareActivityText' } });
    }
}

type ListProps<T> = Pick<
    FlatListProps<T>,
    'data' | 'renderItem' | 'keyExtractor' | 'ListEmptyComponent' | 'ListFooterComponent' | 'refreshControl' | 'extraData'
>;

interface ActivityScreenProps<T> extends ListProps<T> {
    readonly title: string;
    readonly onBack: () => void;
    /** Absent: no Share pill (nothing to share yet). */
    readonly onShare?: () => void;
    readonly shareTestID: string;
    readonly intro?: string | null;
    /** Under the intro, still in the list header (column headings, a calendar). */
    readonly headerExtra?: React.ReactNode;
    readonly testID: string;
}

/**
 * A pushed Activity screen: back, then ONE list whose header is the title
 * row (title + Share), the intro and any extra. Restorable (resume spot) and
 * clear of the tab bar and the Mera button.
 */
export function ActivityScreen<T>({
    title,
    onBack,
    onShare,
    shareTestID,
    intro,
    headerExtra,
    testID,
    ...list
}: ActivityScreenProps<T>): React.ReactElement {
    const c = useColors();
    const endClearance = useListEndClearance();
    const header = (
        <View style={styles.header}>
            <View style={styles.titleRow}>
                <Text
                    accessibilityRole="header"
                    style={{ flex: 1, color: c.ink, fontSize: 30, lineHeight: 40, fontWeight: '700' }}
                    testID={`${testID}-title`}
                >
                    {title}
                </Text>
                {onShare ? <SharePill onPress={onShare} testID={shareTestID} /> : null}
            </View>
            {intro ? (
                <Text style={{ color: c.ink2, fontSize: 14, lineHeight: 21 }} testID={`${testID}-intro`}>
                    {intro}
                </Text>
            ) : null}
            {headerExtra}
        </View>
    );
    return (
        <View style={{ flex: 1 }} testID={testID}>
            <DrillDownHeader title={title} titleContent={<View />} onBack={onBack} backTestID={`${testID}-back`} />
            <View style={{ flex: 1 }}>
                <FlatList
                    {...list}
                    ListHeaderComponent={header}
                    contentContainerStyle={{ paddingHorizontal: SIDE, paddingBottom: endClearance }}
                    showsVerticalScrollIndicator={false}
                    onScroll={notifyScrollTick}
                    scrollEventThrottle={16}
                />
            </View>
        </View>
    );
}

/** A thin proportion bar: `share` of the width in the accent. */
export const ShareBar: React.FC<{ readonly share: number; readonly strong?: boolean }> = ({ share, strong = true }) => {
    const c = useColors();
    return (
        <View
            accessible={false}
            accessibilityElementsHidden
            importantForAccessibility="no-hide-descendants"
            style={[styles.bar, { backgroundColor: c.surface }]}
        >
            <View
                style={[
                    styles.bar,
                    { width: `${Math.round(Math.max(0, Math.min(1, share)) * 100)}%`, backgroundColor: c.accent, opacity: strong ? 1 : 0.55 },
                ]}
            />
        </View>
    );
};

const styles = StyleSheet.create({
    pillFrame: { paddingVertical: 4, marginVertical: -4, flexShrink: 0 },
    pill: {
        minHeight: 36,
        paddingHorizontal: 14,
        borderRadius: 999,
        borderWidth: 1,
        flexDirection: 'row',
        alignItems: 'center',
        gap: 6,
    },
    header: { paddingTop: 12, paddingBottom: 16, gap: 12 },
    titleRow: { flexDirection: 'row', alignItems: 'center', gap: 12 },
    bar: { height: 6, borderRadius: 999 },
});
