// Languages (Activity's Languages card): EVERY language of the articles opened
// in the last 30 days, with its articles, share and a bar (`languageRows`).
// Shares here count ARTICLES; the card's bar weighs taps, so a much re-opened
// article can move the two apart by a point or two. A language opens What you
// opened filtered to it. Share sends the Languages card image.

import TapPressable from '@/components/custom/cards/TapPressable';
import { ActivityScreen, openLibraryScreen, ShareBar } from '@/components/custom/library/activity-ui';
import { useActivityVisits } from '@/components/custom/library/use-activity-visits';
import { usePreviewBox } from '@/components/custom/library/use-preview-box';
import StatsShareModal from '@/components/custom/share-stats/StatsShareModal';
import { Box } from '@/components/ui/box';
import { Spinner } from '@/components/ui/spinner';
import { Text } from '@/components/ui/text';
import { getLocalizedLanguageName } from '@/lib/algorithms/language-names';
import { languageRows, type LanguageRow } from '@/lib/stats/activity';
import { useColors } from '@/lib/theme/tokens';
import React, { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { StyleSheet, View } from 'react-native';

const CARD: [['languages']] = [['languages']];

const LanguagesScreen: React.FC<{ readonly onBack: () => void }> = ({ onBack }) => {
    const { t, i18n } = useTranslation();
    const c = useColors();
    const { visits, loading, stats } = useActivityVisits();
    const rows = useMemo(() => languageRows(visits), [visits]);
    const { rootRef, onLayout, box } = usePreviewBox();
    const [shareOpen, setShareOpen] = useState(false);

    return (
        <View ref={rootRef} onLayout={onLayout} collapsable={false} style={{ flex: 1 }}>
            <ActivityScreen
                title={t('library.stats.languages')}
                onBack={onBack}
                onShare={rows.length > 0 ? () => setShareOpen(true) : undefined}
                shareTestID="languages-share"
                intro={rows.length > 0 ? t('library.activity.languagesIntro', { count: rows.length }) : null}
                testID="languages"
                data={rows}
                keyExtractor={(r: LanguageRow) => r.languageCode}
                renderItem={({ item, index }) => {
                    const name = getLocalizedLanguageName(item.languageCode, i18n.language) ?? item.languageCode.toUpperCase();
                    const pct = `${Math.round(item.share * 100)}%`;
                    const articles = t('library.activity.articles', { count: item.articles });
                    return (
                        <TapPressable
                            onPress={() => openLibraryScreen('reading-log', { language: item.languageCode })}
                            accessibilityRole="button"
                            accessibilityLabel={`${name}, ${articles}, ${pct}`}
                            testID={`languages-row-${item.languageCode}`}
                            style={[styles.row, { backgroundColor: c.surface, borderColor: c.line }, index > 0 ? styles.gap : null]}
                        >
                            <View pointerEvents="none" style={{ gap: 8 }}>
                                <View style={styles.line}>
                                    <Text numberOfLines={1} style={{ flex: 1, color: c.ink, fontSize: 16, lineHeight: 22, fontWeight: '600' }}>
                                        {name}
                                    </Text>
                                    <Text style={{ color: c.ink2, fontSize: 14, lineHeight: 20 }}>{articles}</Text>
                                    <Text style={{ color: c.ink, fontSize: 14, lineHeight: 20, fontWeight: '700', minWidth: 40, textAlign: 'right' }}>
                                        {pct}
                                    </Text>
                                </View>
                                <ShareBar share={item.share} strong={index === 0} />
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
            />
            <StatsShareModal open={shareOpen} onClose={() => setShareOpen(false)} groups={CARD} stats={stats} box={box} />
        </View>
    );
};

const styles = StyleSheet.create({
    row: { borderRadius: 14, borderWidth: StyleSheet.hairlineWidth, padding: 14 },
    gap: { marginTop: 8 },
    line: { flexDirection: 'row', alignItems: 'baseline', gap: 10 },
});

export default LanguagesScreen;
