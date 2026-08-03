'use client';
// Vendored gluestack-ui Tabs, adapted for this app. Upstream ships this file via
// `npx gluestack-ui add tabs`, but the generated version targets the newer
// "uniwind" generation and does not run here as-is. Four deliberate deviations,
// each load-bearing:
//
//  1. HEADLESS LOGIC COMES FROM AN ALIASED v5.  `tabs/creator` does not exist in
//     the installed `@gluestack-ui/core@3.0.10` (it first shipped in 4.1.0-alpha).
//     Rather than bump core 3 -> 5 — which would re-point all 26 other vendored
//     primitives at a different styling generation — v5 is aliased in
//     package.json as `@gluestack-ui/tabs-core` and imported ONLY here.
//     `UIIcon` deliberately still comes from the INSTALLED v3 core, so there is
//     exactly one icon creator in the bundle.
//     The creator is pure React + react-native (no react-aria, no native code),
//     so this stays an OTA-shippable change.
//  2. NO `styled` FROM NATIVEWIND.  Upstream imports `{ styled } from 'nativewind'`,
//     which does not exist in nativewind@4.2.1 and throws at runtime. Replaced
//     with `cssInterop`, matching components/ui/icon/index.tsx.
//  3. TOKENS REMAPPED.  Upstream uses uniwind semantic tokens (`bg-muted`,
//     `text-foreground`, `bg-background`, `border-primary`). None exist in this
//     repo's tailwind.config.js, so they would silently render nothing. See the
//     token table above each style below.
//  4. NO AUTO-SCROLL-TO-CENTRE.  Upstream re-centres the selected trigger on
//     every selection change. That fights the Dashboard header's pull-to-refresh
//     geometry and is a behaviour nobody asked for, so it is not ported.
import { createTabs, TabsContext, useTabsTriggerContext } from '@gluestack-ui/tabs-core/tabs/creator';
import { UIIcon } from '@gluestack-ui/core/icon/creator';
import {
    tva,
    useStyleContext,
    withStyleContext,
    type VariantProps,
} from '@gluestack-ui/utils/nativewind-utils';
import { cssInterop } from 'nativewind';
import React, { useMemo, useRef } from 'react';
import { FlatList, Platform, Pressable, Text, View } from 'react-native';
import Animated, {
    runOnJS,
    useAnimatedScrollHandler,
    useAnimatedStyle,
    useSharedValue,
    withSpring,
} from 'react-native-reanimated';
import { TabsAnimatedIndicator } from './TabsAnimatedIndicator';

const SCOPE = 'TABS';
const AnimatedView = Animated.createAnimatedComponent(View);
const AnimatedFlatList = Animated.createAnimatedComponent(FlatList);

/** Styles */

const tabsStyle = tva({
    base: 'w-full gap-1',
});

// upstream `bg-muted` -> `bg-background-muted` (dark: rgb(34,34,34)).
const tabsListStyle = tva({
    base: 'flex relative z-10 bg-background-muted p-1 rounded-lg',
    variants: {
        orientation: {
            horizontal: 'flex-row',
            vertical: 'flex-col',
        },
    },
});

// upstream `ring-primary/20` -> `ring-primary-400/20` (web-only focus ring).
const tabsTriggerStyle = tva({
    base: 'justify-center relative z-30 items-center web:outline-none data-[disabled=true]:opacity-40 data-[focus-visible=true]:web:ring-2 data-[focus-visible=true]:web:ring-primary-400/20 px-3 py-1.5 flex-row gap-1',
    parentVariants: {
        variant: {
            underlined: '',
            filled: 'rounded-lg',
        },
    },
});

// upstream `text-foreground/70` -> `text-typography-500` (dark: rgb(163,163,163));
// upstream `text-foreground`    -> `text-typography-950` (dark: rgb(254,254,255)).
// NB: selection is applied from the trigger CONTEXT rather than upstream's
// `data-[selected=true]:` variant — the creator hands the selected state to the
// styled trigger as a `states` prop, and a plain react-native `Pressable` (which
// is what upstream wires in as `Trigger`) does not turn that into a `dataSet`,
// so the data- variant never activates on native. Reading the context makes the
// primitive work standalone instead of only when a call site passes its own
// classes.
const tabsTriggerTextStyle = tva({
    base: 'font-medium',
    variants: {
        selected: {
            true: 'text-typography-950',
            false: 'text-typography-500',
        },
    },
});

const tabsTriggerIconStyle = tva({
    base: 'h-4 w-4 fill-none pointer-events-none shrink-0',
    variants: {
        selected: {
            true: 'text-typography-950',
            false: 'text-typography-500',
        },
    },
});

const tabsContentStyle = tva({
    base: 'p-2 h-auto',
});

const tabsContentWrapperStyle = tva({
    base: 'overflow-hidden rounded-lg',
});

// upstream `bg-background` -> `bg-background-200`, NOT `bg-background-0`.
// This repo's dark ramp is INVERTED (0 = darkest), so upstream's intent — an
// indicator LIGHTER than its track — needs a higher step here:
//   background-muted (track) = rgb(34,34,34)
//   background-0             = rgb(18,17,19)  <- darker than the track
//   background-50            = rgb(34,34,34)  <- identical to the track
//   background-200           = rgb(68,68,68)  <- reads as a raised pill
// In light mode this is inverted again (muted 243 vs 200 -> 220, i.e. slightly
// recessed but still legible); the in-flight light/dark sweep owns that call.
// upstream `border-primary` -> `border-primary-400`.
const tabsIndicatorStyle = tva({
    base: 'pointer-events-none',
    parentVariants: {
        variant: {
            underlined: 'border-b border-primary-400',
            filled: 'bg-background-200 z-20 rounded-lg',
        },
    },
});

/** Creator */

const Root = withStyleContext(View, SCOPE);

// Upstream uses `styled(UIIcon, { className: 'style' })`; nativewind@4.2.1 has no
// `styled` export. cssInterop is the supported equivalent and is what
// components/ui/icon/index.tsx already does.
cssInterop(UIIcon, { className: 'style' });

const UITabs = createTabs({
    Root,
    List: View,
    Trigger: Pressable,
    Content: View,
    ContentWrapper: AnimatedView,
    TriggerText: Text,
    TriggerIcon: UIIcon,
    Indicator: View,
});

/** Type definitions */

type ITabsProps = React.ComponentPropsWithoutRef<typeof UITabs> &
    VariantProps<typeof tabsStyle> & {
        variant?: 'underlined' | 'filled';
    };
type ITabsListProps = React.ComponentPropsWithoutRef<typeof UITabs.List>;
type ITabsTriggerProps = React.ComponentPropsWithoutRef<typeof UITabs.Trigger>;
type ITabsContentProps = React.ComponentPropsWithoutRef<typeof UITabs.Content>;
type ITabsContentWrapperProps = React.ComponentPropsWithoutRef<typeof UITabs.ContentWrapper>;
type ITabsTriggerTextProps = React.ComponentPropsWithoutRef<typeof UITabs.TriggerText>;
type ITabsTriggerIconProps = React.ComponentPropsWithoutRef<typeof UITabs.TriggerIcon> & {
    as?: React.ElementType;
};
type ITabsIndicatorProps = React.ComponentPropsWithoutRef<typeof UITabs.Indicator>;

/** Components */

const Tabs = React.forwardRef<React.ComponentRef<typeof UITabs>, ITabsProps>(
    ({ className, variant = 'filled', ...props }, ref) => (
        <UITabs
            ref={ref}
            {...props}
            className={tabsStyle({ class: className })}
            // @ts-ignore - variants are passed down through the style context
            context={{ variant }}
        />
    ),
);

const TabsList = React.forwardRef<React.ComponentRef<typeof UITabs.List>, ITabsListProps>(
    ({ className, children, ...props }, ref) => {
        const context = React.useContext(TabsContext);
        const flatListRef = useRef<any>(null);

        // Shared value the indicator reads so it can track sideways scrolling on
        // the UI thread. Hooks must run unconditionally — upstream calls
        // useAnimatedScrollHandler inside a Platform ternary, which is a
        // rules-of-hooks violation and fails lint here.
        const animatedScrollOffset = useSharedValue(0);
        const setScrollOffset = context?.setScrollOffset;

        const nativeScrollHandler = useAnimatedScrollHandler({
            onScroll: (event) => {
                'worklet';
                const x = event.contentOffset.x;
                animatedScrollOffset.value = x;
                if (setScrollOffset) runOnJS(setScrollOffset)(x);
            },
        });

        // Memoized so the FlatList's `data` stays referentially stable across
        // scroll-driven re-renders: `scrollOffset` lives in context and ticks on
        // every scroll event, and without this every cell would re-render (and
        // re-fire onLayout -> measureTrigger) on every frame.
        const { triggers, indicator } = useMemo(() => {
            const childArray = React.Children.toArray(children);
            return {
                triggers: childArray.filter((child: any) => child?.type?.displayName !== 'TabsIndicator'),
                indicator: childArray.find((child: any) => child?.type?.displayName === 'TabsIndicator'),
            };
        }, [children]);

        React.useEffect(() => {
            if (context) {
                // @ts-ignore - expose the shared value to the indicator
                context.animatedScrollOffset = animatedScrollOffset;
            }
        }, [context, animatedScrollOffset]);

        if (!context) return null;

        const { orientation, listRef } = context;

        const handleWebScroll = (e: any) => {
            const x = e.nativeEvent.contentOffset.x;
            animatedScrollOffset.value = x;
            setScrollOffset?.(x);
        };

        if (orientation === 'horizontal') {
            return (
                <View ref={listRef} className={tabsListStyle({ orientation, class: className })}>
                    {indicator}
                    <AnimatedFlatList
                        ref={flatListRef}
                        horizontal
                        data={triggers}
                        renderItem={({ item }) => item as any}
                        keyExtractor={(item: any, index) => item?.props?.value ?? `tab-${index}`}
                        showsHorizontalScrollIndicator={false}
                        scrollEventThrottle={16}
                        style={{ zIndex: 100 }}
                        onScroll={Platform.OS === 'web' ? handleWebScroll : nativeScrollHandler}
                        {...props}
                    />
                </View>
            );
        }

        return (
            <UITabs.List ref={ref} {...props} className={tabsListStyle({ orientation, class: className })}>
                {children}
            </UITabs.List>
        );
    },
);

const TabsTrigger = React.forwardRef<React.ComponentRef<typeof UITabs.Trigger>, ITabsTriggerProps>(
    ({ className, ...props }, ref) => {
        const { variant } = useStyleContext(SCOPE);
        return (
            <UITabs.Trigger
                ref={ref}
                {...props}
                className={tabsTriggerStyle({ parentVariants: { variant }, class: className })}
            />
        );
    },
);

const TabsContent = React.forwardRef<React.ComponentRef<typeof UITabs.Content>, ITabsContentProps>(
    ({ className, ...props }, ref) => (
        <UITabs.Content ref={ref} {...props} className={tabsContentStyle({ class: className })} />
    ),
);

const TabsContentWrapper = React.forwardRef<
    React.ComponentRef<typeof UITabs.ContentWrapper>,
    ITabsContentWrapperProps
>(({ className, targetHeight, ...props }: any, ref) => {
    const context = React.useContext(TabsContext);
    const selectedLayout = context?.selectedKey ? context.contentLayouts.get(context.selectedKey) : null;
    const height = selectedLayout?.height || 0;

    const heightValue = useSharedValue(height);
    const isFirstRender = useRef(true);

    React.useEffect(() => {
        if (height <= 0) return;
        if (isFirstRender.current) {
            heightValue.value = height;
            isFirstRender.current = false;
        } else {
            heightValue.value = withSpring(height, { duration: 100 });
        }
    }, [height, heightValue]);

    const animatedStyle = useAnimatedStyle(() => ({
        height: heightValue.value > 0 ? heightValue.value : 'auto',
    }), []);

    return (
        <UITabs.ContentWrapper
            ref={ref}
            style={animatedStyle}
            {...props}
            className={tabsContentWrapperStyle({ class: className })}
        />
    );
});

const TabsTriggerText = React.forwardRef<React.ComponentRef<typeof UITabs.TriggerText>, ITabsTriggerTextProps>(
    ({ className, ...props }, ref) => {
        const { isSelected } = useTabsTriggerContext('TabsTriggerText');
        return (
            <UITabs.TriggerText
                ref={ref}
                {...props}
                className={tabsTriggerTextStyle({ selected: isSelected, class: className })}
            />
        );
    },
);

const TabsTriggerIcon = React.forwardRef<React.ComponentRef<typeof UITabs.TriggerIcon>, ITabsTriggerIconProps>(
    ({ className, ...props }, ref) => {
        const { isSelected } = useTabsTriggerContext('TabsTriggerIcon');

        // Strip `dataSet` on web only, to avoid a React DOM warning.
        const safeProps =
            Platform.OS === 'web'
                ? (() => {
                      const { dataSet, ...rest } = props as any;
                      return rest;
                  })()
                : props;

        return (
            <UITabs.TriggerIcon
                ref={ref}
                {...safeProps}
                className={tabsTriggerIconStyle({ selected: isSelected, class: className })}
            />
        );
    },
);

const TabsIndicator = React.forwardRef<React.ComponentRef<typeof UITabs.Indicator>, ITabsIndicatorProps>(
    ({ className, ...props }, ref) => {
        const context = React.useContext(TabsContext);
        const { variant } = useStyleContext(SCOPE);

        if (!context) return null;

        const { selectedKey, orientation, triggerLayouts, scrollOffset } = context;
        // @ts-ignore - set by TabsList
        const animatedScrollOffset = context.animatedScrollOffset;

        return (
            <TabsAnimatedIndicator
                ref={ref}
                selectedKey={selectedKey}
                orientation={orientation}
                triggerLayouts={triggerLayouts}
                scrollOffset={scrollOffset}
                animatedScrollOffset={animatedScrollOffset}
                className={tabsIndicatorStyle({ parentVariants: { variant }, class: className })}
                {...props}
            />
        );
    },
);

Tabs.displayName = 'Tabs';
TabsList.displayName = 'TabsList';
TabsTrigger.displayName = 'TabsTrigger';
TabsContent.displayName = 'TabsContent';
TabsContentWrapper.displayName = 'TabsContentWrapper';
TabsTriggerText.displayName = 'TabsTriggerText';
TabsTriggerIcon.displayName = 'TabsTriggerIcon';
TabsIndicator.displayName = 'TabsIndicator';

export {
    Tabs,
    TabsContent,
    TabsContentWrapper,
    TabsIndicator,
    TabsList,
    TabsTrigger,
    TabsTriggerIcon,
    TabsTriggerText,
};
