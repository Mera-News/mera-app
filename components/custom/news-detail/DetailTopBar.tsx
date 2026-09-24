import { Box } from '@/components/ui/box';
import { Pressable } from '@/components/ui/pressable';
import { MaterialIcons } from '@expo/vector-icons';
import React, { useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import Animated, {
    type SharedValue,
    useAnimatedStyle,
    useSharedValue,
    withTiming,
} from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import {
    DETAIL_BACK_TOP_OFFSET,
    DETAIL_TOP_BAR_HEIGHT,
} from '@/components/custom/news-detail/detail-top-bar-metrics';

export {
    DETAIL_BACK_SIZE,
    DETAIL_BACK_TOP_OFFSET,
    DETAIL_TOP_BAR_HEIGHT,
} from '@/components/custom/news-detail/detail-top-bar-metrics';
/** Fade of the plate, both ways. */
export const DETAIL_TOP_BAR_FADE_MS = 150;
/** The bar once solid: OPAQUE. A 90% fill with the translucent plate on top
 *  read as a grey band with the headline showing through it (725). */
export const DETAIL_TOP_BAR_FILL = 'rgb(18,17,19)';

/**
 * The detail screens' ONE cover value (0 at rest, 1 once the meta row has
 * scrolled under the top bar), animated on each crossing. The screen hands
 * `cover` to BOTH `DetailTopBar` and `<StatusBarScrim overHero>`, so the
 * status area and the bar behind the back button turn solid together, and
 * passes `onTopBarSolidChange` to `ArticleSuggestionContainer`.
 */
export function useDetailTopBarCover(): {
    cover: SharedValue<number>;
    onTopBarSolidChange: (solid: boolean) => void;
} {
    const cover = useSharedValue(0);
    const onTopBarSolidChange = useCallback(
        (solid: boolean) => {
            cover.value = withTiming(solid ? 1 : 0, { duration: DETAIL_TOP_BAR_FADE_MS });
        },
        [cover],
    );
    return { cover, onTopBarSolidChange };
}

export interface DetailTopBarProps {
    onBack: () => void;
    /** 'home' on a deep-linked screen with no history behind it. */
    backIcon?: 'back' | 'home';
    /** M8/F31: `useDetailTopBarCover().cover`. As it rises an opaque bar fades
     *  in behind the status bar and the button; without it the floating
     *  button sat on top of the meta row ("1d ago") once the reader scrolled.
     *  Omitted (loading and error states): no bar. */
    cover?: SharedValue<number>;
}

/**
 * The detail screens' floating back control, in ONE place so every state of
 * those screens renders it: loaded, loading, offline, error. The loading
 * branches used to render only a spinner, so on a slow network (the by-id
 * query aborts at 30s) the reader had no visible way back.
 *
 * Positioned absolutely at the safe-area top, above the status-bar scrim
 * (zIndex 5) and the content. With `cover`, a full-width opaque bar fades in
 * behind it, from the screen top to under the button.
 */
const DetailTopBar: React.FC<DetailTopBarProps> = ({ onBack, backIcon = 'back', cover }) => {
    const { t } = useTranslation();
    const insets = useSafeAreaInsets();
    const none = useSharedValue(0);
    const progress = cover ?? none;
    const plateStyle = useAnimatedStyle(() => ({ opacity: progress.value }));

    return (
        <>
            <Animated.View
                testID="detail-top-plate"
                pointerEvents="none"
                accessibilityElementsHidden
                importantForAccessibility="no-hide-descendants"
                style={[
                    {
                        position: 'absolute',
                        left: 0,
                        right: 0,
                        top: 0,
                        height: insets.top + DETAIL_TOP_BAR_HEIGHT,
                        zIndex: 19,
                        backgroundColor: DETAIL_TOP_BAR_FILL,
                    },
                    plateStyle,
                ]}
            />
            <Box
                pointerEvents="box-none"
                style={{ position: 'absolute', left: 8, top: insets.top + DETAIL_BACK_TOP_OFFSET, zIndex: 20 }}
            >
                <Pressable
                    testID="detail-back"
                    onPress={onBack}
                    accessibilityRole="button"
                    accessibilityLabel={t(backIcon === 'home' ? 'common.home' : 'common.back')}
                    className="bg-gray-900 rounded-full p-3 shadow-hard-2"
                >
                    <MaterialIcons
                        name={backIcon === 'home' ? 'home' : 'arrow-back'}
                        size={24}
                        color="#ffffff"
                    />
                </Pressable>
            </Box>
        </>
    );
};

export default DetailTopBar;
