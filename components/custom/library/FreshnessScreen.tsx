// How fresh (Activity's How fresh card): how old each article was when the
// reader opened it, in five bands (`freshnessBands`, the same publish-to-read
// rows as the card's median), with how many articles had no publish time.
// Share sends the How fresh card image (the median); the bands are not on it.

import { ActivityScreen, ShareBar } from '@/components/custom/library/activity-ui';
import { useActivityVisits } from '@/components/custom/library/use-activity-visits';
import { usePreviewBox } from '@/components/custom/library/use-preview-box';
import StatsShareModal from '@/components/custom/share-stats/StatsShareModal';
import { Text } from '@/components/ui/text';
import { FRESH_BANDS, freshnessBands, type FreshBand } from '@/lib/stats/activity';
import { cardHasData } from '@/lib/stats/reading-stats';
import { useColors } from '@/lib/theme/tokens';
import React, { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { StyleSheet, View } from 'react-native';

const CARD: [['fresh']] = [['fresh']];

const FreshnessScreen: React.FC<{ readonly onBack: () => void }> = ({ onBack }) => {
    const { t } = useTranslation();
    const c = useColors();
    const { visits, loading, stats } = useActivityVisits();
    const fresh = useMemo(() => freshnessBands(visits), [visits]);
    const { rootRef, onLayout, box } = usePreviewBox();
    const [shareOpen, setShareOpen] = useState(false);
    const missing = fresh.total - fresh.sampled;
    const shown = !loading && fresh.sampled > 0;

    return (
        <View ref={rootRef} onLayout={onLayout} collapsable={false} style={{ flex: 1 }}>
            <ActivityScreen
                title={t('library.stats.fresh')}
                onBack={onBack}
                onShare={cardHasData(stats, 'fresh') ? () => setShareOpen(true) : undefined}
                shareTestID="freshness-share"
                intro={t('library.activity.freshIntro')}
                testID="freshness"
                data={shown ? FRESH_BANDS : []}
                keyExtractor={(b: FreshBand) => b}
                renderItem={({ item, index }) => (
                    <View
                        style={[styles.row, { backgroundColor: c.surface, borderColor: c.line }, index > 0 ? styles.gap : null]}
                        accessible
                        accessibilityLabel={`${t(`library.activity.band.${item}`)}, ${fresh.counts[index]}`}
                        testID={`freshness-band-${item}`}
                    >
                        <View style={styles.line}>
                            <Text style={{ flex: 1, color: c.ink, fontSize: 16, lineHeight: 22, fontWeight: '600' }}>
                                {t(`library.activity.band.${item}`)}
                            </Text>
                            <Text style={{ color: c.ink, fontSize: 15, lineHeight: 22, fontWeight: '700' }}>{String(fresh.counts[index])}</Text>
                        </View>
                        <ShareBar share={fresh.counts[index] / fresh.sampled} />
                    </View>
                )}
                ListFooterComponent={
                    shown ? (
                        <Text style={{ fontSize: 13, lineHeight: 19, color: c.ink3, marginTop: 12 }} testID="freshness-note">
                            {missing > 0
                                ? t('library.activity.freshNote', { sampled: fresh.sampled, count: fresh.total, missing })
                                : t('library.activity.freshNoteAll')}
                        </Text>
                    ) : null
                }
            />
            <StatsShareModal open={shareOpen} onClose={() => setShareOpen(false)} groups={CARD} stats={stats} box={box} />
        </View>
    );
};

const styles = StyleSheet.create({
    row: { borderRadius: 14, borderWidth: StyleSheet.hairlineWidth, padding: 14, gap: 8 },
    gap: { marginTop: 8 },
    line: { flexDirection: 'row', alignItems: 'baseline', gap: 10 },
});

export default FreshnessScreen;
