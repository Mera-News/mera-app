import type { LayoutData } from '@gluestack-ui/tabs-core/tabs/creator';
import React, { useEffect, useState } from 'react';
import { Platform } from 'react-native';
import Animated, {
    Easing,
    type SharedValue,
    useAnimatedStyle,
    useSharedValue,
    withDelay,
    withTiming,
} from 'react-native-reanimated';
import { tabsAnimationConfig } from './animation-config';

interface TabsAnimatedIndicatorProps {
    readonly selectedKey: any;
    readonly orientation: 'horizontal' | 'vertical';
    readonly triggerLayouts: Map<any, LayoutData>;
    readonly scrollOffset?: number;
    readonly animatedScrollOffset?: SharedValue<number>;
    readonly className?: string;
    readonly style?: any;
}

const isWeb = Platform.OS === 'web';

/**
 * The sliding selection indicator for `Tabs`. Position and size come from the
 * per-trigger layouts the creator registers (`measureInWindow` relative to the
 * TabsList wrapper), so the indicator tracks whatever the triggers actually
 * measure rather than assuming equal widths — which matters here, because the
 * Dashboard's sub-tab labels differ in width per language.
 *
 * Horizontal indicators subtract the list's scroll offset, so the indicator
 * stays glued to its trigger when the strip is scrolled sideways.
 */
export const TabsAnimatedIndicator = React.forwardRef<any, TabsAnimatedIndicatorProps>(
    ({ selectedKey, orientation, triggerLayouts, scrollOffset = 0, animatedScrollOffset, className, style }, ref) => {
        const animatedX = useSharedValue(0);
        const animatedY = useSharedValue(0);
        const animatedWidth = useSharedValue(0);
        const animatedHeight = useSharedValue(0);
        const [hasLayout, setHasLayout] = useState(false);
        const scrollOffsetShared = useSharedValue(scrollOffset);

        useEffect(() => {
            if (!animatedScrollOffset) {
                scrollOffsetShared.value = scrollOffset;
            }
        }, [scrollOffset, scrollOffsetShared, animatedScrollOffset]);

        useEffect(() => {
            if (!selectedKey || !triggerLayouts.has(selectedKey)) return;
            const layout = triggerLayouts.get(selectedKey);
            if (!layout || layout.width <= 0) return;

            // First paint must not animate in from x=0 — it would fly across the
            // strip on mount.
            const duration = hasLayout ? tabsAnimationConfig.indicatorDuration : 0;

            animatedX.value = withDelay(20, withTiming(layout.x, { duration, easing: Easing.ease }));
            animatedY.value = withTiming(layout.y, { duration, easing: Easing.ease });
            animatedWidth.value = withTiming(layout.width, { duration, easing: Easing.ease });
            animatedHeight.value = withTiming(layout.height, { duration, easing: Easing.ease });

            if (!hasLayout) setHasLayout(true);
        }, [selectedKey, triggerLayouts, hasLayout, animatedX, animatedY, animatedWidth, animatedHeight]);

        const animatedStyle = useAnimatedStyle(() => {
            'worklet';
            const offset = animatedScrollOffset ? animatedScrollOffset.value : scrollOffsetShared.value;
            const xPos = orientation === 'horizontal' ? animatedX.value - offset : animatedX.value;

            // Web: reanimated does not reliably flush the transform array to a CSS
            // transform string, so use left/top there. Native keeps the transform
            // so the animation stays on the UI thread.
            if (isWeb) {
                return {
                    left: xPos,
                    top: animatedY.value,
                    width: animatedWidth.value,
                    height: animatedHeight.value,
                };
            }

            return {
                transform: [{ translateX: xPos }, { translateY: animatedY.value }],
                width: animatedWidth.value,
                height: animatedHeight.value,
            };
        }, [orientation, animatedX, animatedY, animatedWidth, animatedHeight]);

        // Nothing to draw until at least one trigger has reported its layout.
        if (!hasLayout) return null;

        return (
            <Animated.View
                ref={ref}
                className={className}
                style={[animatedStyle, style, { position: 'absolute', zIndex: 1 }]}
            />
        );
    },
);

TabsAnimatedIndicator.displayName = 'TabsAnimatedIndicator';
