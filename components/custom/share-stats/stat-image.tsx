// The shared Stats image and the measure that packs picks onto as few images
// as fit (owner). A one-figure image keeps the big style and its window title
// ("Publications · last 30 days", or "Right now"). A packed image is titled
// "Your last 30 days", draws every figure in the denser `packed` style with its
// own label (Right now included, like the Stats page), the charted figures
// full width and the short ones two to a row. The measure renders the SAME
// blocks, so heights never disagree.

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

/** The space between packed rows, and between the two columns of a row. */
export const BLOCK_GAP = 14;
const COL_GAP = 12;

/** Figures with a chart take a full row; the rest go two to a row. */
const CHARTED: ReadonlySet<StatsCardId> = new Set(['publications', 'languages', 'days']);

/** A packed row: one charted figure, or up to two short ones. Order kept. */
export function toUnits(ids: readonly StatsCardId[]): StatsCardId[][] {
    const units: StatsCardId[][] = [];
    for (let i = 0; i < ids.length; i++) {
        const id = ids[i];
        const next = ids[i + 1];
        if (!CHARTED.has(id) && next !== undefined && !CHARTED.has(next)) {
            units.push([id, next]);
            i++;
        } else {
            units.push([id]);
        }
    }
    return units;
}

/** One figure as it sits on an image: alone in the big style, or packed with
 *  its label. */
const StatBlock: React.FC<{
    readonly id: StatsCardId;
    readonly stats: ReadingStats;
    readonly k: number;
    readonly labelled: boolean;
    readonly onLayout?: (e: LayoutChangeEvent) => void;
    readonly style?: object;
}> = ({ id, stats, k, labelled, onLayout, style }) => {
    const { t } = useTranslation();
    const { ink } = useCardInk();
    return (
        <View onLayout={onLayout} style={style}>
            {labelled ? (
                <Text
                    allowFontScaling={false}
                    style={[type(SHELL_METRICS.title, k), { marginBottom: 4 * k }, ink('secondary')]}
                >
                    {statLabel(t, id)}
                </Text>
            ) : null}
            <StatFigure id={id} stats={stats} variant={labelled ? 'packed' : 'image'} k={k} />
        </View>
    );
};

/** One shared image: the shell (logo, title, privacy line) around its figures. */
export const StatImage = React.forwardRef<View, {
    readonly ids: readonly StatsCardId[];
    readonly stats: ReadingStats;
    readonly hostSize?: { width: number; height: number };
    /** On screen, draw the whole 9:16 frame as exported (reserves included). */
    readonly fullFrame?: boolean;
}>(function StatImage({ ids, stats, hostSize, fullFrame }, ref) {
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
            fullFrame={fullFrame}
            testID={`share-image-${ids.join('-')}`}
        >
            {packed ? (
                <View style={{ gap: BLOCK_GAP * k }}>
                    {toUnits(ids).map((unit) => (
                        <View key={unit.join('-')} style={{ flexDirection: 'row', columnGap: COL_GAP * k }}>
                            {unit.map((id) => (
                                <StatBlock key={id} id={id} stats={stats} k={k} labelled style={{ flex: 1 }} />
                            ))}
                        </View>
                    ))}
                </View>
            ) : (
                <StatBlock id={ids[0]} stats={stats} k={k} labelled={false} />
            )}
        </CardShell>
    );
});

export interface PackMeasurement {
    /** The height figures may fill on one image, in design points. */
    readonly capacity: number;
    /** Each figure's packed block height (full width when charted, half
     *  width otherwise), in design points. */
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
    const contentW = host.width - 2 * SHELL_METRICS.outerPadding;
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
            <View style={{ width: contentW }}>
                {cards.map((id) => (
                    <StatBlock
                        key={id}
                        id={id}
                        stats={stats}
                        k={1}
                        labelled
                        style={{ width: CHARTED.has(id) ? contentW : (contentW - COL_GAP) / 2 }}
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

/** The picks grouped into images, packed by rows once measured (one per
 *  image before). */
export function packGroups(
    picks: readonly StatsCardId[],
    m: PackMeasurement | null,
): StatsCardId[][] {
    if (!m || picks.some((id) => m.heights[id] === undefined)) return picks.map((id) => [id]);
    const units = toUnits(picks);
    return packStatCards(
        units.map((u) => Math.max(...u.map((id) => m.heights[id] ?? 0))),
        m.capacity,
        BLOCK_GAP,
    ).map((group) => group.flatMap((i) => units[i]));
}
