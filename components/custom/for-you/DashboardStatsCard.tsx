// The feed's counts card (FinalFeed #1, FinalFeedStatus #1-5). One card, three
// homes: open at the top of an empty Feed (`initiallyExpanded`), slid in over
// the list from the status icon (StatusCardSlideIn), and, until the status
// icon replaces it, at the head of the Feed and Interests lists.
//
// Level 1: the status line (a light sweeps across it while a sync runs) and a
// chevron, then the count sentence ("being analysed" while syncing, with the
// 20pt processing scene beside it). The sentence says nothing at zero
// articles, the normal state of a capped account. Level 2, under the chevron
// and INSIDE the same card: FeedStatusDetails. At the daily limit or on a
// problem the whole card is FeedStatusNotice instead: no chevron, no counts.
//
// `mode` is injectable so the kit gallery can show the limit and problem
// states, which no simulator reaches.
//
// No announcement here: FeedScreen announces the capped and error states.

import { GlassPanel } from '@/components/custom/GlassSurface';
import LoopScene from '@/components/custom/for-you/LoopScene';
import { processingAnimationFor } from '@/components/custom/processing/animation-registry';
import { HStack } from '@/components/ui/hstack';
import { Pressable } from '@/components/ui/pressable';
import { type FeedStatusMode } from '@/lib/feed-status-mode';
import { useFeedCounts } from '@/lib/hooks/use-feed-counts';
import { useFeedStatusMode } from '@/lib/hooks/use-feed-status-mode';
import { MaterialIcons } from '@expo/vector-icons';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { StyleSheet, View } from 'react-native';
import { ShimmerText } from '@/components/ui/shimmer';
import { Text } from '@/components/ui/text';
import { MOTION } from '@/lib/motion';
import { useColors } from '@/lib/theme/tokens';
import Animated, { FadeIn, FadeOut, useReducedMotion } from 'react-native-reanimated';
import FeedStatsSentence from './FeedStatsSentence';
import FeedStatusDetails, { AnalysingProgress, FeedStatusNotice } from './FeedStatusDetails';
import { measureAnchor } from './stats-card-dropdown';
import { useStatusDropdown } from './status-dropdown';
import { a11yStateKey, STATUS_INK } from './status-ink';

const HIDDEN = {
    accessible: false,
    accessibilityElementsHidden: true,
    importantForAccessibility: 'no-hide-descendants',
} as const;

const SCENE_SIZE = 20;

export interface DashboardStatsCardProps {
    /** Injected by the kit gallery; the live mode otherwise. */
    readonly mode?: FeedStatusMode;
    /** The chevron opens the details inside this card (the slide-in and the
     *  empty Feed). Without it, the legacy dropdown opens. */
    readonly expandInPlace?: boolean;
    /** Details open from the first frame (the empty Feed, FinalFeed #1). */
    readonly initiallyExpanded?: boolean;
    /** Drawn over list content: an opaque base, or the cards read through. */
    readonly overContent?: boolean;
    /** Called before "Manage plan" or the upgrade link navigates. */
    readonly onBeforeNavigate?: () => void;
    readonly testID?: string;
}

/** The status line. While a sync runs a soft light sweeps across it
 *  (ShimmerText owns Reduce Motion and Lite). */
function StatusLine({ label, syncing }: { label: string; syncing: boolean }) {
    const colors = useColors();
    const style = [styles.line, { color: colors.ink }];
    return syncing ? (
        <ShimmerText style={styles.line} numberOfLines={1} testID="dashboard-stats-card-state">
            {label}
        </ShimmerText>
    ) : (
        <Text numberOfLines={1} style={style} testID="dashboard-stats-card-state">
            {label}
        </Text>
    );
}

export const DashboardStatsCard: React.FC<DashboardStatsCardProps> = ({
    mode: modeOverride,
    expandInPlace = false,
    initiallyExpanded = false,
    overContent = false,
    onBeforeNavigate,
    testID = 'dashboard-stats-card',
}) => {
    const { t } = useTranslation();
    // `a11yStateKey` is computed from the mode; see its own note on `tAny`.
    const tAny = t as unknown as (key: string) => string;
    const liveMode = useFeedStatusMode();
    const mode = modeOverride ?? liveMode;
    const { articleCount } = useFeedCounts();
    const dropdown = useStatusDropdown();
    const [ownExpanded, setOwnExpanded] = useState(initiallyExpanded);
    const expanded = expandInPlace ? ownExpanded : dropdown.expanded;
    const stateLabel = tAny(a11yStateKey(mode));
    const processing = mode === 'processing';

    const reduceMotion = useReducedMotion();
    const colors = useColors();

    const anchorRef = useRef<View>(null);
    const toggle = useCallback(() => {
        if (expandInPlace) setOwnExpanded((v) => !v);
        else if (dropdown.expanded) dropdown.collapse();
        else measureAnchor(anchorRef.current, dropdown.open);
    }, [expandInPlace, dropdown]);

    const notice = mode === 'limited' || mode === 'error';

    return (
        // `collapsable={false}`: a flattened view has nothing native to measure.
        <View ref={anchorRef} collapsable={false} className="mb-2" testID={`${testID}-anchor`}>
            <GlassPanel
                radius={12}
                contentClassName="px-4 py-3"
                style={overContent ? { backgroundColor: colors.modalBase } : undefined}
                testID={testID}
            >
                {notice ? (
                    <FeedStatusNotice mode={mode} onBeforeNavigate={onBeforeNavigate} />
                ) : (
                    <>
                        {/* A hidden visual under a CHILDLESS labelled button: a
                            glyph inside a button surfaces on iOS as its own
                            StaticText (captured class, ux2). */}
                        <View>
                            <View pointerEvents="none" {...HIDDEN}>
                                <HStack className="items-center" space="sm">
                                    <View style={{ flex: 1, minWidth: 0 }}>
                                        <StatusLine label={stateLabel} syncing={processing} />
                                    </View>
                                    <MaterialIcons
                                        name={expanded ? 'expand-less' : 'expand-more'}
                                        size={20}
                                        color={STATUS_INK.secondary}
                                        {...HIDDEN}
                                    />
                                </HStack>
                                {articleCount > 0 ? (
                                    <HStack className="items-start mt-1" space="sm">
                                        {processing ? (
                                            <LoopScene
                                                source={processingAnimationFor('analysing')}
                                                size={SCENE_SIZE}
                                                testID={`${testID}-scene`}
                                            />
                                        ) : null}
                                        <View style={{ flex: 1, minWidth: 0 }}>
                                            <FeedStatsSentence
                                                syncing={processing}
                                                className="text-typography-700 font-medium"
                                            />
                                        </View>
                                    </HStack>
                                ) : null}
                            </View>
                            <Pressable
                                onPress={toggle}
                                accessibilityRole="button"
                                accessibilityState={{ expanded }}
                                accessibilityLabel={`${stateLabel}. ${t(
                                    expanded ? 'feedStatus.collapseA11y' : 'feedStatus.expandA11y',
                                )}`}
                                testID={`${testID}-toggle`}
                                style={StyleSheet.absoluteFill}
                            />
                        </View>
                        {expandInPlace && expanded ? (
                            <Animated.View
                                entering={reduceMotion ? undefined : FadeIn.duration(MOTION.status.open)}
                                exiting={reduceMotion ? undefined : FadeOut.duration(MOTION.status.close)}
                            >
                                <FeedStatusDetails />
                                {processing ? <AnalysingProgress /> : null}
                            </Animated.View>
                        ) : null}
                    </>
                )}
            </GlassPanel>
        </View>
    );
};

const styles = StyleSheet.create({
    // fontSize with its own lineHeight (the ui Text clipping trap).
    line: { fontSize: 14, lineHeight: 20, fontWeight: '600' },
});

export default DashboardStatsCard;
