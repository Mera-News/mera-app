// History, a screen pushed in the Library stack (reached from Activity's Most
// opened card or its History row, Where you read, the visit badge and the old
// `visited-publications` link): a note on supporting the reporting, the
// intro, then the publications whose sites the reader opened in the last 30
// days as a table (flag, publication, visits, last read). With `country` only
// that country's publications show (`use-history`).
//
// Visits are RAW visits (taps) summed across every name a publication is known
// by (`mergeVisitedByName`); the publication page's "opened N times" counts the
// same rows. Subscribe and Support live on the publication page only, so this
// screen makes no per-row network lookup. Share sends the table as text.

import TapPressable from '@/components/custom/cards/TapPressable';
import ForYouEmptyState from '@/components/custom/for-you/ForYouEmptyState';
import { ActivityScreen, countryLabel, shareActivityText } from '@/components/custom/library/activity-ui';
import { useHistory } from '@/components/custom/library/use-history';
import { openPublicationPage } from '@/components/custom/publication-page/open-publication-page';
import { SourceFlag } from '@/components/custom/SourceFlag';
import { openTutorial } from '@/components/custom/tutorials/open-tutorial';
import { Box } from '@/components/ui/box';
import { Spinner } from '@/components/ui/spinner';
import { Text } from '@/components/ui/text';
import type { VisitedPublication } from '@/lib/database/services/publication-visit-service';
import { calendarDaysAgo, formatDayMonth } from '@/lib/stats/visited-publications';
import { useDisplayPublication, usePublicationDisplayStore } from '@/lib/stores/publication-display-store';
import { useColors, useThemeMode } from '@/lib/theme/tokens';
import { MaterialIcons } from '@expo/vector-icons';
import React, { useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { I18nManager, type ListRenderItem, RefreshControl, StyleSheet, View } from 'react-native';

const COL_VISITS = 56;
const COL_LAST = 84;

interface Props {
    /** Only this country's publications (alpha-3, as visits store it). */
    readonly country: string | null;
    readonly onBack: () => void;
}

function lastReadLabel(t: (k: 'common.today' | 'common.yesterday') => string, ms: number, locale?: string): string {
    const days = calendarDaysAgo(ms, Date.now());
    if (days <= 0) return t('common.today');
    if (days === 1) return t('common.yesterday');
    return formatDayMonth(ms, locale);
}

const TableRow: React.FC<{
    readonly item: VisitedPublication;
    readonly first: boolean;
    readonly last: boolean;
    readonly locale?: string;
    readonly onOpen: (item: VisitedPublication) => void;
}> = ({ item, first, last, locale, onOpen }) => {
    const { t } = useTranslation();
    const c = useColors();
    const name = useDisplayPublication(item.publicationName);
    const lastRead = lastReadLabel(t, item.lastVisitedAt, locale);
    return (
        <TapPressable
            onPress={() => onOpen(item)}
            accessibilityRole="button"
            accessibilityLabel={`${name}, ${t('library.history.colVisits')} ${item.visitCount}, ${t('library.history.colLastRead')} ${lastRead}`}
            testID={`history-row-${item.publicationName}`}
            style={[styles.row, { backgroundColor: c.surface, borderColor: c.line }, first ? styles.rowFirst : null, last ? styles.rowLast : null]}
        >
            <View style={styles.rowInner} pointerEvents="none" accessible={false} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
                <SourceFlag countryCode={item.countryCode} size="sm" />
                <Text numberOfLines={1} style={[styles.cellName, { color: c.ink }]}>
                    {name}
                </Text>
                <Text style={[styles.cellNum, { color: c.ink, width: COL_VISITS }]}>{String(item.visitCount)}</Text>
                <Text numberOfLines={1} style={[styles.cellNum, { color: c.ink2, width: COL_LAST }]}>
                    {lastRead}
                </Text>
                <MaterialIcons name={I18nManager.isRTL ? 'chevron-left' : 'chevron-right'} size={18} color={c.ink3} />
            </View>
        </TapPressable>
    );
};

/** The note at the top (Activity boards: a dark inset, the orange hands). */
const SupportNote: React.FC = () => {
    const { t } = useTranslation();
    const c = useColors();
    const mode = useThemeMode();
    return (
        <View
            style={[styles.note, { backgroundColor: mode === 'light' ? c.surface : 'rgba(0,0,0,0.25)' }]}
            testID="history-support-note"
        >
            <MaterialIcons name="volunteer-activism" size={22} color={c.accent} accessible={false} />
            <View style={{ flex: 1, gap: 6 }}>
                <Text style={{ color: c.ink, fontSize: 15, lineHeight: 22, fontWeight: '700' }}>{t('library.activity.supportTitle')}</Text>
                <Text style={{ color: c.ink2, fontSize: 14, lineHeight: 21 }}>{t('library.activity.supportBody')}</Text>
            </View>
        </View>
    );
};

const HistoryScreen: React.FC<Props> = ({ country, onBack }) => {
    const { t, i18n } = useTranslation();
    const c = useColors();
    const { items, loading, reload } = useHistory(country);
    const displayNames = usePublicationDisplayStore((s) => s.names);
    const [refreshing, setRefreshing] = useState(false);

    const onRefresh = useCallback(async () => {
        setRefreshing(true);
        await reload();
        setRefreshing(false);
    }, [reload]);

    const open = useCallback((item: VisitedPublication) => {
        // History lands on the publication's own History view (owner); every
        // other entry point keeps the default.
        openPublicationPage({ rawName: item.publicationName, countryCode: item.countryCode }, 'HISTORY');
    }, []);

    const share = useCallback(() => {
        const label = country ? `${t('publicationPage.history')}, ${countryLabel(t, country)}` : t('publicationPage.history');
        void shareActivityText(
            t,
            t('shareStats.card.windowLine', { label }),
            items.map((i) => `${displayNames[i.publicationName] ?? i.publicationName}: ${t('library.activity.visits', { count: i.visitCount })}`),
        );
    }, [country, items, displayNames, t]);

    const renderItem: ListRenderItem<VisitedPublication> = useCallback(
        ({ item, index }) => <TableRow item={item} first={index === 0} last={index === items.length - 1} locale={i18n?.language} onOpen={open} />,
        [i18n?.language, open, items.length],
    );

    const headerExtra = (
        <>
            <SupportNote />
            <Text style={{ fontSize: 14, lineHeight: 21, color: c.ink2 }} testID="history-intro">
                {t('library.history.intro')}
            </Text>
            {country ? (
                <View style={styles.countryRow} testID="history-country">
                    <SourceFlag countryCode={country} size="sm" />
                    <Text style={{ color: c.ink, fontSize: 15, lineHeight: 21, fontWeight: '600' }}>{countryLabel(t, country)}</Text>
                </View>
            ) : null}
            {items.length > 0 ? (
                // Column headings above the card (FinalLibrary: padding 0 14 6).
                <View
                    style={styles.headRow}
                    accessible
                    accessibilityRole="header"
                    accessibilityLabel={t('library.history.title')}
                    testID="history-head"
                >
                    <Text style={[styles.headCell, { color: c.ink3, flex: 1 }]}>{t('library.history.colPublication')}</Text>
                    <Text style={[styles.headCell, styles.cellNum, { color: c.ink3, width: COL_VISITS }]}>
                        {t('library.history.colVisits')}
                    </Text>
                    <Text style={[styles.headCell, styles.cellNum, { color: c.ink3, width: COL_LAST + 18 }]}>
                        {t('library.history.colLastRead')}
                    </Text>
                </View>
            ) : null}
        </>
    );

    return (
        <ActivityScreen
            title={t('publicationPage.history')}
            onBack={onBack}
            onShare={items.length > 0 ? share : undefined}
            shareTestID="history-share"
            headerExtra={headerExtra}
            testID="visited-publications-list"
            data={items}
            renderItem={renderItem}
            keyExtractor={(item: VisitedPublication) => `${item.publicationName}::${item.countryCode ?? ''}`}
            ListFooterComponent={
                items.length > 0 ? (
                    <Text style={{ fontSize: 12, lineHeight: 17, color: c.ink3, marginTop: 8 }} testID="history-footnote">
                        {t('library.history.footnote')}
                    </Text>
                ) : null
            }
            ListEmptyComponent={
                loading ? (
                    <Box className="items-center justify-center py-20">
                        <Spinner size="large" />
                    </Box>
                ) : (
                    <ForYouEmptyState
                        icon="history"
                        title={t('library.visited.emptyTitle')}
                        body={t('library.history.emptyBody')}
                        action={{
                            label: t('library.history.learn'),
                            onPress: () => openTutorial('library', 'history'),
                            testID: 'history-learn',
                        }}
                        testID="visited-publications-empty"
                    />
                )
            }
            refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={c.accent} colors={[c.accent]} />}
        />
    );
};

const styles = StyleSheet.create({
    // The board's History table (FinalLibrary): radius 16, rows 52pt with 8/14
    // padding, the column headings above the card (padding 0 14 6).
    row: {
        borderLeftWidth: StyleSheet.hairlineWidth,
        borderRightWidth: StyleSheet.hairlineWidth,
        borderBottomWidth: StyleSheet.hairlineWidth,
        minHeight: 52,
        justifyContent: 'center',
    },
    rowFirst: { borderTopWidth: StyleSheet.hairlineWidth, borderTopLeftRadius: 16, borderTopRightRadius: 16 },
    headRow: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 14, paddingTop: 8, marginBottom: -10 },
    rowLast: { borderBottomLeftRadius: 16, borderBottomRightRadius: 16 },
    rowInner: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 14, paddingVertical: 8 },
    cellName: { flex: 1, fontSize: 15, lineHeight: 20, fontWeight: '600' },
    cellNum: { fontSize: 14, lineHeight: 19, textAlign: 'right' },
    headCell: { fontSize: 12, lineHeight: 16, fontWeight: '600' },
    note: { borderRadius: 12, paddingVertical: 14, paddingHorizontal: 16, flexDirection: 'row', gap: 12, alignItems: 'flex-start' },
    countryRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
});

export default HistoryScreen;
