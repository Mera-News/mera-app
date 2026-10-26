// What you opened (Activity's Days you read and Opened at the source cards):
// a month calendar of the last 30 days (tap a day to see only it, Show all
// days clears), then every article opened at the source, newest first. A row
// opens the article as the publication page's History rows do. With
// `language` (from Languages) only that language's articles show. Share sends
// what is listed as text.

import TapPressable from '@/components/custom/cards/TapPressable';
import { ActivityScreen, shareActivityText } from '@/components/custom/library/activity-ui';
import { useReadingLog } from '@/components/custom/library/use-reading-log';
import { SourceFlag } from '@/components/custom/SourceFlag';
import { Box } from '@/components/ui/box';
import { Pressable } from '@/components/ui/pressable';
import { Spinner } from '@/components/ui/spinner';
import { Text } from '@/components/ui/text';
import { getLocalizedLanguageName } from '@/lib/algorithms/language-names';
import type { VisitedArticle } from '@/lib/database/services/publication-visit-service';
import { useOpenArticle } from '@/lib/hooks/use-open-article';
import { peakDayCount, type DayRead } from '@/lib/stats/reading-stats';
import { calendarDaysAgo, formatDayMonth } from '@/lib/stats/visited-publications';
import { usePublicationDisplayStore } from '@/lib/stores/publication-display-store';
import { useColors } from '@/lib/theme/tokens';
import type { TFunction } from 'i18next';
import React, { useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { StyleSheet, View } from 'react-native';

interface Props {
    readonly initialDay: string | null;
    readonly language: string | null;
    readonly onBack: () => void;
}

/** Midday of a local `YYYY-MM-DD`, so no timezone shift crosses midnight. */
function dayMs(dateKey: string): number {
    const [y, m, d] = dateKey.split('-').map(Number);
    return new Date(y, m - 1, d, 12).getTime();
}

function safeDate(ms: number, locale: string | undefined, opts: Intl.DateTimeFormatOptions, time = false): string {
    try {
        return time ? new Date(ms).toLocaleTimeString(locale, opts) : new Date(ms).toLocaleDateString(locale, opts);
    } catch {
        return time ? new Date(ms).toLocaleTimeString() : new Date(ms).toLocaleDateString();
    }
}

/** "Today, 27 Oct", "Yesterday, 26 Oct", else "Friday 24 Oct". */
function dayHeading(t: TFunction, ms: number, locale?: string): string {
    const ago = calendarDaysAgo(ms, Date.now());
    if (ago === 0) return `${t('common.today')}, ${formatDayMonth(ms, locale)}`;
    if (ago === 1) return `${t('common.yesterday')}, ${formatDayMonth(ms, locale)}`;
    return safeDate(ms, locale, { weekday: 'long', day: 'numeric', month: 'short' });
}

const Calendar: React.FC<{
    readonly days: readonly DayRead[];
    readonly picked: string | null;
    readonly onPick: (day: string) => void;
}> = ({ days, picked, onPick }) => {
    const { t, i18n } = useTranslation();
    const c = useColors();
    const peak = peakDayCount([...days]);
    const lead = days[0]?.weekday ?? 0;
    const weekdays = t('shareStats.card.rhythmWeekdays').split(',').map((d) => d.trim());
    return (
        <View testID="reading-log-calendar">
            <View style={styles.week} accessible={false} importantForAccessibility="no-hide-descendants">
                {weekdays.map((d, i) => (
                    <Text key={i} style={[styles.weekday, { color: c.ink3 }]}>
                        {d}
                    </Text>
                ))}
            </View>
            <View style={styles.grid}>
                {Array.from({ length: lead }, (_, i) => (
                    <View key={`pad-${i}`} style={styles.cell} />
                ))}
                {days.map((d) => {
                    const ms = dayMs(d.dateKey);
                    const selected = d.dateKey === picked;
                    const shade = d.count > 0 && peak > 0 ? 0.25 + 0.75 * (d.count / peak) : 0;
                    return (
                        <View key={d.dateKey} style={styles.cell}>
                            <Pressable
                                onPress={() => onPick(d.dateKey)}
                                disabled={d.count === 0}
                                accessibilityRole="button"
                                accessibilityState={{ selected, disabled: d.count === 0 }}
                                accessibilityLabel={`${safeDate(ms, i18n?.language, { weekday: 'long', day: 'numeric', month: 'long' })}, ${t('library.activity.articles', { count: d.count })}`}
                                testID={`reading-log-day-${d.dateKey}`}
                                style={[
                                    styles.dayBox,
                                    { backgroundColor: c.surface, borderColor: selected ? c.ink : 'transparent' },
                                ]}
                            >
                                {shade > 0 ? (
                                    <View style={[StyleSheet.absoluteFill, styles.dayFill, { backgroundColor: c.accent, opacity: shade }]} />
                                ) : null}
                                <Text style={{ color: d.count > 0 ? c.ink : c.ink3, fontSize: 15, lineHeight: 20, fontWeight: selected ? '700' : '500' }}>
                                    {String(new Date(ms).getDate())}
                                </Text>
                            </Pressable>
                        </View>
                    );
                })}
            </View>
        </View>
    );
};

const ReadingLogScreen: React.FC<Props> = ({ initialDay, language, onBack }) => {
    const { t, i18n } = useTranslation();
    const c = useColors();
    const locale = i18n?.language;
    const log = useReadingLog({ language, initialDay });
    const openArticle = useOpenArticle();
    const displayNames = usePublicationDisplayStore((s) => s.names);
    const languageName = language ? (getLocalizedLanguageName(language, locale) ?? language.toUpperCase()) : null;
    const pub = useCallback((v: VisitedArticle) => displayNames[v.publicationName] ?? v.publicationName, [displayNames]);
    const headline = (v: VisitedArticle) => v.titleOriginal ?? v.titleEn ?? '';
    const time = (v: VisitedArticle) => safeDate(v.visitedAt, locale, { hour: '2-digit', minute: '2-digit' }, true);
    const dayLabel = log.day ? dayHeading(t, dayMs(log.day), locale) : null;

    const share = () => {
        const label = [t('library.activity.logTitle'), languageName, dayLabel].filter(Boolean).join(', ');
        void shareActivityText(
            t,
            t('shareStats.card.windowLine', { label }),
            log.rows.map((v) => `${headline(v)} (${pub(v)})`),
        );
    };

    const headerExtra = (
        <>
            {languageName ? (
                <Text style={{ color: c.ink, fontSize: 15, lineHeight: 21, fontWeight: '600' }} testID="reading-log-language">
                    {languageName}
                </Text>
            ) : null}
            {log.all.length > 0 ? <Calendar days={log.days} picked={log.day} onPick={log.setDay} /> : null}
            {dayLabel ? (
                <View style={styles.dayRow}>
                    <Text accessibilityRole="header" style={{ flex: 1, color: c.ink, fontSize: 18, lineHeight: 26, fontWeight: '700' }} testID="reading-log-day-heading">
                        {dayLabel}
                    </Text>
                    <Pressable
                        onPress={() => log.setDay(null)}
                        accessibilityRole="button"
                        testID="reading-log-show-all"
                        style={{ minHeight: 44, justifyContent: 'center', paddingStart: 8 }}
                    >
                        <Text style={{ color: c.accentText, fontSize: 14, lineHeight: 20, fontWeight: '600' }}>{t('library.activity.showAllDays')}</Text>
                    </Pressable>
                </View>
            ) : null}
        </>
    );

    return (
        <ActivityScreen
            title={t('library.activity.logTitle')}
            onBack={onBack}
            onShare={log.rows.length > 0 ? share : undefined}
            shareTestID="reading-log-share"
            intro={log.all.length > 0 ? t('library.activity.logIntro', { count: log.all.length }) : null}
            headerExtra={headerExtra}
            testID="reading-log"
            data={log.rows as VisitedArticle[]}
            extraData={displayNames}
            keyExtractor={(v: VisitedArticle, i: number) => `${v.articleId ?? v.articleUrl ?? i}`}
            renderItem={({ item, index }) => {
                const when = log.day ? time(item) : `${formatDayMonth(item.visitedAt, locale)}, ${time(item)}`;
                const meta = `${pub(item)} · ${when}`;
                const id = item.articleId;
                return (
                    <TapPressable
                        onPress={id ? () => openArticle({ articleId: id }) : undefined}
                        disabled={!id}
                        accessibilityRole={id ? 'button' : undefined}
                        accessibilityLabel={`${headline(item)}, ${meta}`}
                        testID={`reading-log-row-${id ?? index}`}
                        style={[styles.row, { borderColor: c.line }, index === 0 ? null : styles.rowDivider]}
                    >
                        <View pointerEvents="none" style={{ gap: 4 }}>
                            <View style={styles.meta}>
                                <SourceFlag countryCode={item.countryCode} size="sm" />
                                <Text numberOfLines={1} style={{ flex: 1, color: c.ink3, fontSize: 13, lineHeight: 18, fontWeight: '500' }}>
                                    {meta}
                                </Text>
                            </View>
                            <Text numberOfLines={3} style={{ color: c.ink, fontSize: 15, lineHeight: 21, fontWeight: '600' }}>
                                {headline(item)}
                            </Text>
                        </View>
                    </TapPressable>
                );
            }}
            ListEmptyComponent={
                log.loading ? (
                    <Box className="items-center justify-center py-20">
                        <Spinner size="large" />
                    </Box>
                ) : null
            }
        />
    );
};

const styles = StyleSheet.create({
    week: { flexDirection: 'row', marginBottom: 6 },
    weekday: { width: `${100 / 7}%`, textAlign: 'center', fontSize: 12, lineHeight: 16, fontWeight: '600' },
    grid: { flexDirection: 'row', flexWrap: 'wrap' },
    cell: { width: `${100 / 7}%`, aspectRatio: 1, padding: 3 },
    dayBox: { flex: 1, borderRadius: 10, borderWidth: 1.5, alignItems: 'center', justifyContent: 'center', overflow: 'hidden' },
    dayFill: { borderRadius: 10 },
    dayRow: { flexDirection: 'row', alignItems: 'center' },
    row: { paddingVertical: 12 },
    rowDivider: { borderTopWidth: StyleSheet.hairlineWidth },
    meta: { flexDirection: 'row', alignItems: 'center', gap: 6 },
});

export default ReadingLogScreen;
