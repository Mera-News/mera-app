import React, { forwardRef, ReactNode, useImperativeHandle, useRef } from 'react';
import {
    FlatListProps,
    ListRenderItem,
    StyleProp,
    ViewStyle,
} from 'react-native';
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

interface SmoothFlatListProps<ItemT> {
    /** Content to render as a parallax header */
    parallaxHeader?: ReactNode;
    /** Height of the parallax header (default: 192) */
    headerHeight?: number;
    /** Content rendered above the list, below the parallax header (inside ListHeaderComponent) */
    headerContent?: ReactNode;
    /** Whether to show the vertical scroll indicator */
    showsVerticalScrollIndicator?: boolean;
    /** Additional style for the list */
    style?: StyleProp<ViewStyle>;
    /** Additional style for the content container */
    contentContainerStyle?: StyleProp<ViewStyle>;
    /** Callback to expose scrollY value for external animations */
    onScrollY?: (scrollY: SharedValue<number>) => void;
    /** Callback when scroll position changes (JS thread) */
    onScrollPositionChange?: (y: number) => void;

    // FlatList passthroughs
    data: FlatListProps<ItemT>['data'];
    renderItem: ListRenderItem<ItemT> | null | undefined;
    keyExtractor?: FlatListProps<ItemT>['keyExtractor'];
    ListEmptyComponent?: FlatListProps<ItemT>['ListEmptyComponent'];
    ListFooterComponent?: FlatListProps<ItemT>['ListFooterComponent'];
    onEndReached?: FlatListProps<ItemT>['onEndReached'];
    onEndReachedThreshold?: FlatListProps<ItemT>['onEndReachedThreshold'];
    initialNumToRender?: FlatListProps<ItemT>['initialNumToRender'];
    windowSize?: FlatListProps<ItemT>['windowSize'];
    removeClippedSubviews?: FlatListProps<ItemT>['removeClippedSubviews'];
}

export interface SmoothFlatListRef {
    scrollToTop: (animated?: boolean) => void;
    getScrollY: () => number;
}

/**
 * A smooth-scrolling, virtualized FlatList with optional parallax header effect.
 * FlatList-backed sibling of SmoothScrollView — use this when the content below
 * the header is a long/unbounded list of rows that should be virtualized.
 * Uses react-native-reanimated for native-thread 60fps animations.
 *
 * @example
 * <SmoothFlatList
 *   parallaxHeader={<Image source={...} />}
 *   headerHeight={240}
 *   headerContent={<ClusterSummary />}
 *   data={articles}
 *   renderItem={({ item }) => <ArticleCard article={item} />}
 *   keyExtractor={(item) => item._id}
 *   onEndReached={loadMore}
 * />
 */
function SmoothFlatListInner<ItemT>(
    {
        parallaxHeader,
        headerHeight = HEADER_HEIGHT,
        headerContent,
        showsVerticalScrollIndicator = false,
        style,
        contentContainerStyle,
        onScrollY,
        onScrollPositionChange,
        data,
        renderItem,
        keyExtractor,
        ListEmptyComponent,
        ListFooterComponent,
        onEndReached,
        onEndReachedThreshold = 0.5,
        initialNumToRender,
        windowSize,
        removeClippedSubviews,
    }: SmoothFlatListProps<ItemT>,
    ref: React.Ref<SmoothFlatListRef>,
) {
    const scrollY = useSharedValue(0);
    const flatListRef = useRef<Animated.FlatList<ItemT>>(null);
    const lastScrollY = useRef(0);

    const updateLastScrollY = (y: number) => {
        lastScrollY.current = y;
    };

    const scrollHandler = useAnimatedScrollHandler({
        onScroll: (event) => {
            scrollY.value = event.contentOffset.y;
            runOnJS(updateLastScrollY)(event.contentOffset.y);
            if (onScrollPositionChange) {
                runOnJS(onScrollPositionChange)(event.contentOffset.y);
            }
            runOnJS(notifyScrollTick)();
        },
    });

    // Expose methods via ref
    useImperativeHandle(ref, () => ({
        scrollToTop: (animated = true) => {
            flatListRef.current?.scrollToOffset({ offset: 0, animated });
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

    const listHeader = (parallaxHeader || headerContent) ? (
        <>
            {parallaxHeader ? (
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
            ) : null}
            {headerContent}
        </>
    ) : undefined;

    return (
        <Animated.FlatList
            ref={flatListRef}
            style={style}
            contentContainerStyle={contentContainerStyle}
            onScroll={scrollHandler}
            scrollEventThrottle={16}
            showsVerticalScrollIndicator={showsVerticalScrollIndicator}
            ListHeaderComponent={listHeader}
            data={data}
            renderItem={renderItem}
            keyExtractor={keyExtractor}
            ListEmptyComponent={ListEmptyComponent}
            ListFooterComponent={ListFooterComponent}
            onEndReached={onEndReached}
            onEndReachedThreshold={onEndReachedThreshold}
            initialNumToRender={initialNumToRender}
            windowSize={windowSize}
            removeClippedSubviews={removeClippedSubviews}
        />
    );
}

const SmoothFlatList = forwardRef(SmoothFlatListInner) as <ItemT>(
    props: SmoothFlatListProps<ItemT> & { ref?: React.Ref<SmoothFlatListRef> }
) => ReturnType<typeof SmoothFlatListInner>;

export default SmoothFlatList;
