// The shared Stats image and the measure that packs picks onto as few images
// as fit (owner). A one-figure image keeps its window title ("Publications ·
// last 30 days", or "Right now"); a packed image is titled "Your last 30 days"
// and each figure carries its own label, Right now included, like the Stats
// page. The measure renders the SAME blocks, so heights never disagree.

import { useCardInk } from '@/components/custom/share-stats/card-theme';
import CardShell, {
    DESIGN_WIDTH,
    INK_BOX_ASPECT,
    SHELL_METRICS,
    hostSizeForScale,
    type,
} from '@/components/custom/share-stats/card-shell';
import { packStatCards } from '@/components/custom/share-stats/pack-cards';
import StatFigure, { statLabel, statWindowTitle } from '@/components/custom/share-stats/stat-figures';
import { Text } from '@/components/ui/text';
import type { ReadingStats, StatsCardId } from '@/lib/stats/reading-stats';
import React, { useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { type LayoutChangeEvent, PixelRatio, View } from 'react-native';

/** The space between packed figures, in design points. */
export const BLOCK_GAP = 16;

/** One figure as it sits on an image; labelled when it shares the image. */
const StatBlock: React.FC<{
    readonly id: StatsCardId;
    readonly stats: ReadingStats;
    readonly k: number;
    readonly labelled: boolean;
    readonly onLayout?: (e: LayoutChangeEvent) => void;
}> = ({ id, stats, k, labelled, onLayout }) => {
    const { t } = useTranslation();
    const { ink } = useCardInk();
    return (
        <View onLayout={onLayout}>
            {labelled ? (
                <Text
                    allowFontScaling={false}
                    style={[type(SHELL_METRICS.title, k), { marginBottom: 4 * k }, ink('secondary')]}
                >
                    {statLabel(t, id)}
                </Text>
            ) : null}
            <StatFigure id={id} stats={stats} variant="image" k={k} />
        </View>
    );
};

/** One shared image: the shell (logo, title, privacy line) around its figures. */
export const StatImage = React.forwardRef<View, {
    readonly ids: readonly StatsCardId[];
    readonly stats: ReadingStats;
    readonly hostSize?: { width: number; height: number };
}>(function StatImage({ ids, stats, hostSize }, ref) {
    const { t } = useTranslation();
    const pixelRatio = PixelRatio.get();
    const host = hostSize ?? hostSizeForScale(pixelRatio);
    const k = host.width / DESIGN_WIDTH;
    const packed = ids.length > 1;
    return (
        <CardShell
            ref={ref}
            title={packed ? t('library.stats.title') : statWindowTitle(t, ids[0])}
            privacyLine={t('shareStats.card.privacyMine')}
            pixelRatio={pixelRatio}
            hostSize={hostSize}
            testID={`share-image-${ids.join('-')}`}
        >
            <View style={{ gap: BLOCK_GAP * k }}>
                {ids.map((id) => (
                    <StatBlock key={id} id={id} stats={stats} k={k} labelled={packed} />
                ))}
            </View>
        </CardShell>
    );
});

export interface PackMeasurement {
    /** The height figures may fill on one image, in design points. */
    readonly capacity: number;
    /** Each figure's labelled block height, in design points. */
    readonly heights: Readonly<Partial<Record<StatsCardId, number>>>;
}

/**
 * Off screen, at the design size (k = 1, the export's ink box): an empty
 * packed shell for the capacity, and every figure's labelled block for its
 * height, measured with real text in the current language.
 */
export const PackMeasure: React.FC<{
    readonly cards: readonly StatsCardId[];
    readonly stats: ReadingStats;
    readonly onMeasured: (m: PackMeasurement) => void;
}> = ({ cards, stats, onMeasured }) => {
    const capacity = useRef(0);
    const heights = useRef<Partial<Record<StatsCardId, number>>>({});
    const report = () => {
        if (capacity.current > 0 && cards.every((id) => heights.current[id] !== undefined)) {
            onMeasured({ capacity: capacity.current, heights: { ...heights.current } });
        }
    };
    const host = { width: DESIGN_WIDTH, height: DESIGN_WIDTH / INK_BOX_ASPECT };
    return (
        <View
            pointerEvents="none"
            accessible={false}
            accessibilityElementsHidden
            importantForAccessibility="no-hide-descendants"
            style={{ position: 'absolute', left: -8000, top: 0, width: host.width }}
        >
            <PackShell
                hostSize={host}
                onBodyLayout={(h) => {
                    capacity.current = h;
                    report();
                }}
            />
            <View style={{ width: host.width - 2 * SHELL_METRICS.outerPadding }}>
                {cards.map((id) => (
                    <StatBlock
                        key={id}
                        id={id}
                        stats={stats}
                        k={1}
                        labelled
                        onLayout={(e) => {
                            heights.current[id] = e.nativeEvent.layout.height;
                            report();
                        }}
                    />
                ))}
            </View>
        </View>
    );
};

/** An empty packed shell, for its body height. */
const PackShell: React.FC<{
    readonly hostSize: { width: number; height: number };
    readonly onBodyLayout: (h: number) => void;
}> = ({ hostSize, onBodyLayout }) => {
    const { t } = useTranslation();
    return (
        <CardShell
            title={t('library.stats.title')}
            privacyLine={t('shareStats.card.privacyMine')}
            pixelRatio={PixelRatio.get()}
            hostSize={hostSize}
            testID="share-pack-measure"
            onBodyLayout={onBodyLayout}
        >
            {null}
        </CardShell>
    );
};

/** The picks grouped into images: packed once measured, one per image before. */
export function packGroups(
    picks: readonly StatsCardId[],
    m: PackMeasurement | null,
): StatsCardId[][] {
    if (!m || picks.some((id) => m.heights[id] === undefined)) return picks.map((id) => [id]);
    return packStatCards(
        picks.map((id) => m.heights[id] ?? 0),
        m.capacity,
        BLOCK_GAP,
    ).map((group) => group.map((i) => picks[i]));
}
