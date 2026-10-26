// Where you read (Activity's Publications card): every country the reader
// opened articles from in the last 30 days, with its publications and
// articles (`countryRows`). A country opens History filtered to it. Share
// sends the Publications card image (StatsShareModal with that card alone).

import TapPressable from '@/components/custom/cards/TapPressable';
import { ActivityScreen, countryLabel, openLibraryScreen } from '@/components/custom/library/activity-ui';
import { useActivityVisits } from '@/components/custom/library/use-activity-visits';
import { usePreviewBox } from '@/components/custom/library/use-preview-box';
import StatsShareModal from '@/components/custom/share-stats/StatsShareModal';
import { SourceFlag } from '@/components/custom/SourceFlag';
import { Box } from '@/components/ui/box';
import { Spinner } from '@/components/ui/spinner';
import { Text } from '@/components/ui/text';
import { countryRows, type CountryRow } from '@/lib/stats/activity';
import { useColors } from '@/lib/theme/tokens';
import { MaterialIcons } from '@expo/vector-icons';
import React, { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { I18nManager, StyleSheet, View } from 'react-native';

const COL = 84;
const CARD: [['publications']] = [['publications']];

const WhereYouReadScreen: React.FC<{ readonly onBack: () => void }> = ({ onBack }) => {
    const { t } = useTranslation();
    const c = useColors();
    const { visits, loading, stats } = useActivityVisits();
    const rows = useMemo(() => countryRows(visits), [visits]);
    const { rootRef, onLayout, box } = usePreviewBox();
    const [shareOpen, setShareOpen] = useState(false);

    const summary =
        stats.publicationCount > 0
            ? `${stats.publicationCount} ${
                  stats.publicationCount === 1
                      ? t('library.stats.pubInCountries', { count: stats.countryCount })
                      : t('library.stats.pubsInCountries', { count: stats.countryCount })
              }. ${t('library.activity.countriesHint')}`
            : null;

    return (
        <View ref={rootRef} onLayout={onLayout} collapsable={false} style={{ flex: 1 }}>
            <ActivityScreen
                title={t('library.activity.countriesTitle')}
                onBack={onBack}
                onShare={stats.publicationCount > 0 ? () => setShareOpen(true) : undefined}
                shareTestID="where-you-read-share"
                intro={summary}
                headerExtra={
                    rows.length > 0 ? (
                        <View style={styles.headRow} testID="where-you-read-head">
                            <Text style={[styles.head, { color: c.ink3, flex: 1 }]}>{t('library.activity.colCountry')}</Text>
                            <Text style={[styles.head, styles.num, { color: c.ink3, width: COL }]}>{t('library.stats.publications')}</Text>
                            <Text style={[styles.head, styles.num, { color: c.ink3, width: COL - 20 + 18 + 8 }]}>{t('library.activity.colArticles')}</Text>
                        </View>
                    ) : null
                }
                testID="where-you-read"
                data={rows}
                keyExtractor={(r: CountryRow) => r.countryCode}
                renderItem={({ item, index }) => {
                    const name = countryLabel(t, item.countryCode);
                    return (
                        <TapPressable
                            onPress={() => openLibraryScreen('history', { country: item.countryCode })}
                            accessibilityRole="button"
                            accessibilityLabel={`${name}, ${t('library.stats.publications')} ${item.publications}, ${t('library.activity.articles', { count: item.articles })}`}
                            testID={`where-you-read-row-${item.countryCode}`}
                            style={[
                                styles.row,
                                { backgroundColor: c.surface, borderColor: c.line },
                                index === 0 ? styles.rowFirst : null,
                                index === rows.length - 1 ? styles.rowLast : null,
                            ]}
                        >
                            <View style={styles.rowInner} pointerEvents="none" accessible={false} importantForAccessibility="no-hide-descendants">
                                <SourceFlag countryCode={item.countryCode} size="sm" />
                                <Text numberOfLines={1} style={[styles.name, { color: c.ink }]}>
                                    {name}
                                </Text>
                                <Text style={[styles.num, { color: c.ink, width: COL }]}>{String(item.publications)}</Text>
                                <Text style={[styles.num, { color: c.ink2, width: COL - 20 }]}>{String(item.articles)}</Text>
                                <MaterialIcons name={I18nManager.isRTL ? 'chevron-left' : 'chevron-right'} size={18} color={c.ink3} />
                            </View>
                        </TapPressable>
                    );
                }}
                ListEmptyComponent={
                    loading ? (
                        <Box className="items-center justify-center py-20">
                            <Spinner size="large" />
                        </Box>
                    ) : null
                }
                ListFooterComponent={null}
            />
            <StatsShareModal open={shareOpen} onClose={() => setShareOpen(false)} groups={CARD} stats={stats} box={box} />
        </View>
    );
};

const styles = StyleSheet.create({
    row: {
        borderLeftWidth: StyleSheet.hairlineWidth,
        borderRightWidth: StyleSheet.hairlineWidth,
        borderBottomWidth: StyleSheet.hairlineWidth,
        minHeight: 52,
        justifyContent: 'center',
    },
    rowFirst: { borderTopWidth: StyleSheet.hairlineWidth, borderTopLeftRadius: 16, borderTopRightRadius: 16 },
    rowLast: { borderBottomLeftRadius: 16, borderBottomRightRadius: 16 },
    rowInner: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 14, paddingVertical: 8 },
    name: { flex: 1, fontSize: 15, lineHeight: 20, fontWeight: '600' },
    num: { fontSize: 14, lineHeight: 19, textAlign: 'right' },
    headRow: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 14, paddingTop: 8, marginBottom: -10 },
    head: { fontSize: 12, lineHeight: 16, fontWeight: '600' },
});

export default WhereYouReadScreen;
