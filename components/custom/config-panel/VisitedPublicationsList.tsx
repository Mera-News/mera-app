import TapPressable from '@/components/custom/cards/TapPressable';
import ForYouEmptyState from '@/components/custom/for-you/ForYouEmptyState';
import { openPublicationPage } from '@/components/custom/publication-page/open-publication-page';
import { monogramHueOf, monogramInks, monogramOf } from '@/components/custom/publication-page/publication-format';
import SubscribeConfirmDialog from '@/components/custom/publication-preferences/SubscribeConfirmDialog';
import { useSubscribeFlow } from '@/components/custom/publication-preferences/use-subscribe-flow';
import { Box } from '@/components/ui/box';
import { Spinner } from '@/components/ui/spinner';
import { Text } from '@/components/ui/text';
import {
    getTopVisitedPublications,
    type VisitedPublication,
} from '@/lib/database/services/publication-visit-service';
import { useIsFocusedSafe } from '@/lib/hooks/use-is-focused-safe';
import logger from '@/lib/logger';
import { useTabBarClearance } from '@/lib/navigation/tab-bar';
import { formatDayMonth, hasClearLeader, mergeVisitedByName, subscribedNameSet } from '@/lib/stats/visited-publications';
import { useDisplayPublication } from '@/lib/stores/publication-display-store';
import { normPublicationName } from '@/lib/feed-grouping/geo-language-priority';
import {
    resolvePublisherForSourceName,
    type ResolvedPublisher,
} from '@/lib/subscriptions/publisher-lookup';
import { notifyScrollTick } from '@/lib/visibility-tick';
import { MaterialIcons } from '@expo/vector-icons';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { I18nManager, ListRenderItem, Pressable, RefreshControl, StyleSheet, View } from 'react-native';
import Animated, { useAnimatedScrollHandler } from 'react-native-reanimated';

// The Library's Visited page: the publications the reader opened at the source
// in the last 30 days, most opened first, with a way to support them.
//
// Every figure comes from `publication_visits`, which already exists to run
// this list (invariant 9: nothing new is recorded). Rows are merged by
// normalised name before ranking, so one outlet filed under two spellings or
// countries cannot split the top card.
//
// Subscribe and Support open the publisher's own subscribe page through the
// shared `useSubscribeFlow`, mounted ONCE here with ONE confirm dialog. They
// render only for a publisher the lookup resolved WITH a `subscriptionUri`;
// the lookup fails closed, so a wrong guess never sends anyone to somebody
// else's paywall. "I already pay" is the same durable write the publication
// page's Subscribed state reads (`confirmDirectly` -> `addSubscription`).

const INK = {
    body: 'rgb(212,212,212)',
    muted: 'rgb(163,163,163)',
    accent: '#E78A53',
    onAccent: '#121113',
    paid: '#A9DCC7',
} as const;

const ROW_SURFACE = {
    backgroundColor: 'rgba(255,255,255,0.07)',
    borderColor: 'rgba(255,255,255,0.10)',
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 14,
} as const;

/** Visible pill height and the 44pt frame it sits in (given back by margins). */
const PILL_H = 34;
const PILL_FRAME = 44;

interface Props {
    /** False while a warmed neighbour in a swipe window: reads once, then
     *  re-reads silently each time it becomes visible. Unset = always active. */
    readonly active?: boolean;
    /** The host's collapsing-header scroll handler. Needs the Animated list. */
    readonly scrollHandler?: ReturnType<typeof useAnimatedScrollHandler>;
    /** The host's header height, as the list's top padding. */
    readonly headerHeight?: number;
    /** List-end padding. Defaults to the tab-bar clearance plus a gap. */
    readonly listEndPadding?: number;
    /** Drawn after the footnote (the host's "How this page works" row). */
    readonly footer?: React.ReactElement | null;
}

/** One publisher lookup per RENDERED row (FlatList windowing bounds it), cached
 *  per session by the lookup itself. Null until it answers, and null when it
 *  cannot say: every caller treats null as "offer nothing". */
function useResolvedPublisher(name: string, countryCode: string | null): ResolvedPublisher | null {
    const [resolved, setResolved] = useState<ResolvedPublisher | null>(null);
    useEffect(() => {
        let cancelled = false;
        void resolvePublisherForSourceName(name, countryCode).then((r) => {
            if (!cancelled) setResolved(r);
        });
        return () => {
            cancelled = true;
        };
    }, [name, countryCode]);
    return resolved;
}

const Monogram: React.FC<{ name: string; size: number }> = ({ name, size }) => {
    const inks = monogramInks(monogramHueOf(name));
    return (
        <View
            accessible={false}
            accessibilityElementsHidden
            importantForAccessibility="no-hide-descendants"
            style={{
                width: size,
                height: size,
                borderRadius: 10,
                backgroundColor: inks.fill,
                borderColor: inks.border,
                borderWidth: 1,
                alignItems: 'center',
                justifyContent: 'center',
            }}
        >
            <Text style={{ color: inks.letter, fontSize: 15, lineHeight: 20, fontWeight: '700' }}>
                {monogramOf(name)}
            </Text>
        </View>
    );
};

const RowGap: React.FC = () => <View style={{ height: 8 }} />;

interface PillProps {
    readonly label: string;
    readonly a11yLabel: string;
    readonly a11yHint?: string;
    readonly filled: boolean;
    readonly onPress: () => void;
    readonly testID: string;
}

/** A 34pt pill inside a 44pt frame. Static styles only: a function `style`
 *  on a Pressable is dropped on device in this app. */
const Pill: React.FC<PillProps> = ({ label, a11yLabel, a11yHint, filled, onPress, testID }) => (
    <Pressable
        testID={testID}
        onPress={onPress}
        // Subscribe and Support leave the app, so they are links; the hint
        // says where to. "I already pay" stays here and is a button.
        accessibilityRole={a11yHint ? 'link' : 'button'}
        accessibilityLabel={a11yLabel}
        accessibilityHint={a11yHint}
        style={{ minHeight: PILL_FRAME, justifyContent: 'center', marginVertical: -(PILL_FRAME - PILL_H) / 2 }}
    >
        <View
            style={{
                height: PILL_H,
                paddingHorizontal: filled ? 14 : 12,
                borderRadius: 999,
                justifyContent: 'center',
                backgroundColor: filled ? INK.accent : 'transparent',
                borderWidth: filled ? 0 : 1,
                borderColor: 'rgba(255,255,255,0.22)',
            }}
        >
            <Text
                numberOfLines={1}
                style={{
                    fontSize: 13,
                    lineHeight: 18,
                    fontWeight: filled ? '700' : '400',
                    color: filled ? INK.onAccent : INK.body,
                }}
            >
                {label}
            </Text>
        </View>
    </Pressable>
);

const VisitedPublicationsList: React.FC<Props> = ({
    active = true,
    scrollHandler,
    headerHeight = 0,
    listEndPadding,
    footer,
}) => {
    const tabClearance = useTabBarClearance();
    const { t, i18n } = useTranslation();
    const [items, setItems] = useState<VisitedPublication[]>([]);
    const [isLoading, setIsLoading] = useState(true);
    const [refreshing, setRefreshing] = useState(false);
    const hasFetched = useRef(false);

    const flow = useSubscribeFlow();
    const { begin, confirmDirectly, isSubscribed } = flow;
    const paidNames = useMemo(() => subscribedNameSet(flow.subscriptions.items), [flow.subscriptions.items]);

    const load = useCallback(async () => {
        try {
            const rows = mergeVisitedByName(await getTopVisitedPublications());
            setItems(rows);
        } catch (error) {
            logger.captureException(error, {
                tags: { screen: 'VisitedPublicationsList', method: 'load' },
            });
        }
    }, []);

    // Reload whenever the page becomes VISIBLE (selected AND its tab focused):
    // a visit recorded meanwhile (open an article at its source, come back)
    // must show without the page changing.
    const isFocused = useIsFocusedSafe();
    const visible = active && isFocused;
    useEffect(() => {
        if (!hasFetched.current) {
            hasFetched.current = true;
            setIsLoading(true);
            load().finally(() => setIsLoading(false));
            return;
        }
        if (visible) void load();
    }, [visible, load]);

    const onRefresh = useCallback(async () => {
        setRefreshing(true);
        await load();
        setRefreshing(false);
    }, [load]);

    const showTopCard = hasClearLeader(items);
    const rows = showTopCard ? items.slice(1) : items;

    const isPaid = useCallback(
        (item: VisitedPublication, publisher: ResolvedPublisher | null) =>
            paidNames.has(normPublicationName(item.publicationName) ?? '') ||
            (publisher != null && isSubscribed(publisher.publisherId)),
        [paidNames, isSubscribed],
    );

    const open = useCallback((item: VisitedPublication) => {
        openPublicationPage({ rawName: item.publicationName, countryCode: item.countryCode });
    }, []);

    const renderItem: ListRenderItem<VisitedPublication> = useCallback(
        ({ item }) => (
            <VisitedRow
                item={item}
                locale={i18n?.language}
                isPaid={isPaid}
                onOpen={open}
                onSupport={(p) => void begin(p)}
            />
        ),
        [i18n?.language, isPaid, open, begin],
    );

    const listHeader =
        items.length > 0 ? (
            <View style={{ gap: 12, marginBottom: 12 }}>
                <Text style={{ fontSize: 14, lineHeight: 20, color: INK.body }} testID="visited-intro">
                    {t('library.visited.intro')}
                </Text>
                {showTopCard ? (
                    <TopCard
                        item={items[0]}
                        isPaid={isPaid}
                        onOpen={open}
                        onSubscribe={(p) => void begin(p)}
                        onAlreadyPay={(p) => void confirmDirectly(p)}
                    />
                ) : null}
            </View>
        ) : null;

    const listFooter = (
        <View style={{ marginTop: 4, gap: 16 }}>
            {items.length > 0 ? (
                <Text style={{ fontSize: 12, lineHeight: 17, color: INK.muted }} testID="visited-footnote">
                    {t('library.visited.footnote')}
                </Text>
            ) : null}
            {footer}
        </View>
    );

    return (
        <Box className="flex-1">
            <Animated.FlatList
                testID="visited-publications-list"
                data={rows}
                renderItem={renderItem}
                keyExtractor={(item: VisitedPublication) => item.publicationName}
                ItemSeparatorComponent={RowGap}
                ListHeaderComponent={listHeader}
                ListFooterComponent={listFooter}
                ListEmptyComponent={
                    isLoading ? (
                        <Box className="items-center justify-center py-20">
                            <Spinner size="large" />
                        </Box>
                    ) : items.length === 0 ? (
                        <ForYouEmptyState
                            icon="history"
                            title={t('library.visited.emptyTitle')}
                            body={t('library.visited.emptyBody')}
                            testID="visited-publications-empty"
                        />
                    ) : null
                }
                contentContainerStyle={{
                    paddingTop: headerHeight + 14,
                    paddingHorizontal: 14,
                    paddingBottom: listEndPadding ?? tabClearance + 24,
                }}
                showsVerticalScrollIndicator={false}
                onScroll={scrollHandler ?? notifyScrollTick}
                scrollEventThrottle={16}
                refreshControl={
                    <RefreshControl
                        refreshing={refreshing}
                        onRefresh={onRefresh}
                        tintColor="#ffffff"
                        colors={['#ffffff']}
                        progressViewOffset={headerHeight}
                    />
                }
            />
            <SubscribeConfirmDialog
                publisherName={flow.confirming?.publisherName ?? null}
                onYes={flow.onYes}
                onNo={flow.onNo}
                onDismiss={flow.onDismiss}
            />
        </Box>
    );
};

interface TopCardProps {
    readonly item: VisitedPublication;
    readonly isPaid: (item: VisitedPublication, publisher: ResolvedPublisher | null) => boolean;
    readonly onOpen: (item: VisitedPublication) => void;
    readonly onSubscribe: (publisher: ResolvedPublisher) => void;
    readonly onAlreadyPay: (publisher: ResolvedPublisher) => void;
}

const TopCard: React.FC<TopCardProps> = ({ item, isPaid, onOpen, onSubscribe, onAlreadyPay }) => {
    const { t } = useTranslation();
    const shown = useDisplayPublication(item.publicationName);
    const publisher = useResolvedPublisher(item.publicationName, item.countryCode);
    const paid = isPaid(item, publisher);

    return (
        <View
            testID="visited-top-card"
            style={{
                borderRadius: 18,
                padding: 16,
                gap: 12,
                backgroundColor: 'rgba(231,138,83,0.12)',
                borderWidth: 1,
                borderColor: 'rgba(231,138,83,0.45)',
            }}
        >
            <TapPressable
                testID="visited-top-open"
                onPress={() => onOpen(item)}
                accessibilityRole="button"
                accessibilityLabel={`${shown}, ${t('library.visited.topLine')}`}
                style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}
            >
                <Monogram name={shown} size={48} />
                <View style={{ flex: 1 }}>
                    <Text numberOfLines={1} style={{ fontSize: 17, lineHeight: 22, fontWeight: '700', color: '#FFFFFF' }}>
                        {shown}
                    </Text>
                    <Text style={{ fontSize: 13, lineHeight: 18, color: INK.muted }}>{t('library.visited.topLine')}</Text>
                </View>
            </TapPressable>
            {paid ? (
                <Text testID="visited-top-paid" style={{ fontSize: 13, lineHeight: 18, fontWeight: '600', color: INK.paid }}>
                    {t('library.visited.youPay')}
                </Text>
            ) : publisher ? (
                <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
                    {publisher.subscriptionUri ? (
                        <Pill
                            testID="visited-top-subscribe"
                            label={t('library.visited.subscribe')}
                            a11yLabel={t('subscriptions.subscribeAt', { publisher: shown })}
                            a11yHint={t('subscriptions.opensPublisherSite', { publisher: shown })}
                            filled
                            onPress={() => onSubscribe(publisher)}
                        />
                    ) : null}
                    <Pill
                        testID="visited-top-already"
                        label={t('library.visited.alreadyPay')}
                        a11yLabel={t('library.visited.alreadyPayA11y', { publisher: shown })}
                        filled={false}
                        onPress={() => onAlreadyPay(publisher)}
                    />
                </View>
            ) : null}
        </View>
    );
};

interface VisitedRowProps {
    readonly item: VisitedPublication;
    readonly locale?: string;
    readonly isPaid: (item: VisitedPublication, publisher: ResolvedPublisher | null) => boolean;
    readonly onOpen: (item: VisitedPublication) => void;
    readonly onSupport: (publisher: ResolvedPublisher) => void;
}

/** The row is the tap target for the publication page; Support sits BESIDE it,
 *  never inside, so VoiceOver reaches both and a press on one is never a press
 *  on the other. */
const VisitedRow: React.FC<VisitedRowProps> = ({ item, locale, isPaid, onOpen, onSupport }) => {
    const { t } = useTranslation();
    const shown = useDisplayPublication(item.publicationName);
    const publisher = useResolvedPublisher(item.publicationName, item.countryCode);
    const paid = isPaid(item, publisher);
    const subline = paid
        ? t('library.visited.subscribed')
        : t('library.visited.lastOpened', { date: formatDayMonth(item.lastVisitedAt, locale) });
    const support = !paid && publisher?.subscriptionUri ? publisher : null;

    return (
        <View
            testID={`visited-row-${item.publicationName}`}
            style={[ROW_SURFACE, { flexDirection: 'row', alignItems: 'center', paddingVertical: 12, paddingHorizontal: 14, gap: 12 }]}
        >
            <TapPressable
                testID={`visited-row-open-${item.publicationName}`}
                onPress={() => onOpen(item)}
                accessibilityRole="button"
                accessibilityLabel={`${shown}, ${subline}`}
                style={{ flex: 1, flexDirection: 'row', alignItems: 'center', gap: 12 }}
            >
                <Monogram name={shown} size={40} />
                <View style={{ flex: 1 }}>
                    <Text numberOfLines={1} style={{ fontSize: 15, lineHeight: 20, color: '#FFFFFF' }}>
                        {shown}
                    </Text>
                    <Text style={{ fontSize: 12, lineHeight: 16, color: INK.muted }}>{subline}</Text>
                </View>
                {!paid && !support ? (
                    <MaterialIcons
                        name={I18nManager.isRTL ? 'chevron-left' : 'chevron-right'}
                        size={20}
                        color={INK.muted}
                        accessible={false}
                        accessibilityElementsHidden
                        importantForAccessibility="no-hide-descendants"
                    />
                ) : null}
            </TapPressable>
            {paid ? (
                <Text style={{ fontSize: 13, lineHeight: 18, fontWeight: '600', color: INK.paid }}>
                    {t('library.visited.youPay')}
                </Text>
            ) : support ? (
                <Pill
                    testID={`visited-support-${item.publicationName}`}
                    label={t('library.visited.support')}
                    a11yLabel={t('library.visited.supportA11y', { publisher: shown })}
                    a11yHint={t('subscriptions.opensPublisherSite', { publisher: shown })}
                    filled
                    onPress={() => onSupport(support)}
                />
            ) : null}
        </View>
    );
};

export default VisitedPublicationsList;
