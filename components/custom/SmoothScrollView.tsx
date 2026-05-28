import React, { forwardRef, ReactNode, useImperativeHandle, useRef } from 'react';
import { StyleProp, ViewStyle } from 'react-native';
import { notifyScrollTick } from '@/lib/visibility-tick';
import Animated, {
    interpolate,
    runOnJS,
    SharedValue,
    useAnimatedScrollHandler,
    useAnimatedStyle,
    useSharedValue,
} from 'react-native-reanimated';

const HEADER_HEIGHT = 192; // Default parallax header height (h-48 = 192px)

interface SmoothScrollViewProps {
    children: ReactNode;
    /** Content to render as a parallax header */
    parallaxHeader?: ReactNode;
    /** Height of the parallax header (default: 192) */
    headerHeight?: number;
    /** Whether to show the vertical scroll indicator */
    showsVerticalScrollIndicator?: boolean;
    /** Additional style for the scroll view */
    style?: StyleProp<ViewStyle>;
    /** Additional style for the content container */
    contentContainerStyle?: StyleProp<ViewStyle>;
    /** Callback to expose scrollY value for external animations */
    onScrollY?: (scrollY: SharedValue<number>) => void;
    /** Callback when scroll position changes (JS thread) */
    onScrollPositionChange?: (y: number) => void;
    /** Fires once when the user scrolls near the bottom (FlatList-like). Re-arms after scrolling back up. */
    onEndReached?: () => void;
    /** Fraction of visible height from the bottom at which onEndReached fires. Default 0.5. */
    onEndReachedThreshold?: number;
}

export interface SmoothScrollViewRef {
    scrollToTop: (animated?: boolean) => void;
    getScrollY: () => number;
}

/**
 * A smooth-scrolling ScrollView with optional parallax header effect.
 * Uses react-native-reanimated for native-thread 60fps animations.
 *
 * @example
 * // Basic usage
 * <SmoothScrollView>
 *   <Content />
 * </SmoothScrollView>
 *
 * @example
 * // With parallax header
 * <SmoothScrollView
 *   parallaxHeader={<Image source={...} />}
 *   headerHeight={200}
 * >
 *   <Content />
 * </SmoothScrollView>
 */
const SmoothScrollView = forwardRef<SmoothScrollViewRef, SmoothScrollViewProps>(({
    children,
    parallaxHeader,
    headerHeight = HEADER_HEIGHT,
    showsVerticalScrollIndicator = false,
    style,
    contentContainerStyle,
    onScrollY,
    onScrollPositionChange,
    onEndReached,
    onEndReachedThreshold = 0.5,
}, ref) => {
    const scrollY = useSharedValue(0);
    const scrollViewRef = useRef<Animated.ScrollView>(null);
    const lastScrollY = useRef(0);
    const layoutHeight = useRef(0);
    const contentHeight = useRef(0);
    const hasFiredEndReached = useRef(false);

    const updateLastScrollY = (y: number) => {
        lastScrollY.current = y;
    };

    const maybeFireEndReached = (y: number) => {
        if (!onEndReached) return;
        const layout = layoutHeight.current;
        const content = contentHeight.current;
        if (layout <= 0 || content <= 0) return;
        const distanceFromEnd = content - (y + layout);
        const thresholdPx = onEndReachedThreshold * layout;
        if (distanceFromEnd <= thresholdPx) {
            if (!hasFiredEndReached.current) {
                hasFiredEndReached.current = true;
                onEndReached();
            }
        } else {
            hasFiredEndReached.current = false;
        }
    };

    const handleLayout = (e: { nativeEvent: { layout: { height: number } } }) => {
        layoutHeight.current = e.nativeEvent.layout.height;
        maybeFireEndReached(lastScrollY.current);
    };

    const handleContentSizeChange = (_w: number, h: number) => {
        contentHeight.current = h;
        maybeFireEndReached(lastScrollY.current);
    };

    const scrollHandler = useAnimatedScrollHandler({
        onScroll: (event) => {
            scrollY.value = event.contentOffset.y;
            runOnJS(updateLastScrollY)(event.contentOffset.y);
            if (onScrollPositionChange) {
                runOnJS(onScrollPositionChange)(event.contentOffset.y);
            }
            runOnJS(maybeFireEndReached)(event.contentOffset.y);
            runOnJS(notifyScrollTick)();
        },
    });

    // Expose methods via ref
    useImperativeHandle(ref, () => ({
        scrollToTop: (animated = true) => {
            scrollViewRef.current?.scrollTo({ y: 0, animated });
        },
        getScrollY: () => lastScrollY.current,
    }), []);

    // Expose scrollY to parent if needed
    React.useEffect(() => {
        if (onScrollY) {
            onScrollY(scrollY);
        }
    }, [onScrollY, scrollY]);

    // Parallax effect for header
    const parallaxStyle = useAnimatedStyle(() => {
        const translateY = interpolate(
            scrollY.value,
            [-headerHeight, 0, headerHeight],
            [-headerHeight / 2, 0, headerHeight * 0.5]
        );

        const scale = interpolate(
            scrollY.value,
            [-headerHeight, 0, headerHeight],
            [1.5, 1, 1]
        );

        const opacity = interpolate(
            scrollY.value,
            [0, headerHeight * 0.8],
            [1, 0]
        );

        return {
            transform: [{ translateY }, { scale }],
            opacity,
        };
    });

    if (parallaxHeader) {
        return (
            <Animated.ScrollView
                ref={scrollViewRef}
                style={style}
                contentContainerStyle={contentContainerStyle}
                onScroll={scrollHandler}
                scrollEventThrottle={16}
                showsVerticalScrollIndicator={showsVerticalScrollIndicator}
                onLayout={handleLayout}
                onContentSizeChange={handleContentSizeChange}
            >
                <Animated.View
                    style={[
                        {
                            height: headerHeight,
                            overflow: 'hidden',
                        },
                        parallaxStyle,
                    ]}
                >
                    {parallaxHeader}
                </Animated.View>
                {children}
            </Animated.ScrollView>
        );
    }

    return (
        <Animated.ScrollView
            ref={scrollViewRef}
            style={style}
            contentContainerStyle={contentContainerStyle}
            onScroll={scrollHandler}
            scrollEventThrottle={16}
            showsVerticalScrollIndicator={showsVerticalScrollIndicator}
            onLayout={handleLayout}
            onContentSizeChange={handleContentSizeChange}
        >
            {children}
        </Animated.ScrollView>
    );
});

SmoothScrollView.displayName = 'SmoothScrollView';

export default SmoothScrollView;
