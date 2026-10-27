import type { PageHeaderBinding } from '@/components/custom/nav/types';
import { Pressable } from '@/components/ui/pressable';
import { Text } from '@/components/ui/text';
import type NotificationModel from '@/lib/database/models/Notification';
import { markAllRead, observeAll } from '@/lib/database/services/notification-service';
import { useListEndClearance } from '@/lib/navigation/tab-bar';
import { useColors } from '@/lib/theme/tokens';
import { notifyScrollTick } from '@/lib/visibility-tick';
import { useMotionAllowed } from '@/lib/motion-gate';
import { router, type Href } from 'expo-router';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { View } from 'react-native';
import Animated, { LinearTransition } from 'react-native-reanimated';
import { NOT_KEPT_NOTICE_TYPES } from './notification-actions';
import NotificationRow from './NotificationRow';
import { PAGE_CONTENT_GAP, PAGE_SIDE_INSET } from '@/components/custom/nav/page-registry';
import { usePageScrollTarget } from '@/components/custom/nav/page-scroll';
import { useTrackedScroll } from '@/components/custom/nav/use-tracked-scroll';
import { HygieneSuggestionCard, useHygieneSuggestions } from './HygieneSuggestionCard';

interface NotificationsScreenProps {
    /** The Library tab's shell header (scroll handler, header height). */
    readonly header: PageHeaderBinding;
    /** The visible page of the focused tab. */
    readonly active: boolean;
}

/**
 * Feed > Notifications: one grouped plate of rows (NotificationRow: tone
 * badge, title and age, a two-line preview, delete at the end). A tap does the
 * row's one obvious thing, or opens its sheet when there is a choice or more
 * to read (NotificationSheetHost, mounted in the logged-in layout); delete
 * removes it from this phone at once, no confirm. Seeing the page clears both
 * dots (the Library tab's, unless a fact check also lit it, and this pill),
 * and the seen state never leaves this phone. Empty: one line on what lands
 * here, and the way to its settings.
 */
const NotificationsScreen: React.FC<NotificationsScreenProps> = ({ header, active }) => {
    const { t } = useTranslation();
    // The tab's re-tap scrolls this page to the top (nav/page-scroll).
    const listRef = useRef<Animated.FlatList<NotificationModel>>(null);
    const tracked = useTrackedScroll(header.scrollHandler);
    usePageScrollTarget(listRef, { getOffset: tracked.getOffset });
    const colors = useColors();
    const endClearance = useListEndClearance();
    // Lite / Reduce Motion: a deleted row leaves at once.
    const motion = useMotionAllowed();
    const [rows, setRows] = useState<NotificationModel[]>([]);
    // Tidy-up suggestions are cards above the rows, so their "Tidy up your
    // profile" notice row (still written, for the toast and the dot) is hidden.
    const items = useMemo(() => rows.filter((n) => n.type !== 'hygiene'), [rows]);
    const suggestions = useHygieneSuggestions();
    // Newest first. Rows of types no longer kept (written before Y11, alive
    // for 90 days) stay hidden.
    useEffect(() => {
        const sub = observeAll().subscribe((all) => setRows(all.filter((n) => !NOT_KEPT_NOTICE_TYPES.has(n.type))));
        return () => sub.unsubscribe();
    }, []);

    // Seeing the page clears the dots: mark read while the page is the one on
    // screen, and again when a row lands while it is. Never on unmount: a
    // warmed neighbour that was never shown must not clear anything. Keyed on
    // "any unread", so the write's own re-emit cannot loop.
    // Hidden hygiene rows count too: they light the dot.
    const hasUnread = rows.some((n) => n.status === 'unread');
    useEffect(() => {
        if (active && hasUnread) void markAllRead();
    }, [active, hasUnread]);

    const renderItem = useCallback(
        ({ item, index }: { item: NotificationModel; index: number }) => (
            <NotificationRow n={item} first={index === 0} last={index === items.length - 1} motion={motion} />
        ),
        [items.length, motion],
    );

    const empty = (
        <View testID="notifications-empty" style={{ marginHorizontal: PAGE_SIDE_INSET, gap: 6 }}>
            <Text style={{ color: colors.ink, fontSize: 16, fontWeight: '600' }}>{t('notificationCenter.empty')}</Text>
            <Text style={{ color: colors.ink2, fontSize: 14, lineHeight: 20 }}>{t('notificationCenter.emptyBody')}</Text>
            <Pressable
                testID="notifications-settings-link"
                onPress={() => router.push('/logged-in/app_container/you/notifications' as Href)}
                accessibilityRole="link"
                style={{ minHeight: 44, justifyContent: 'center', alignSelf: 'flex-start' }}
            >
                <Text style={{ color: colors.accentText, fontSize: 15, fontWeight: '600' }}>{t('notificationCenter.settingsLink')}</Text>
            </Pressable>
        </View>
    );

    return (
        <>
            <Animated.FlatList
                ref={listRef}
                testID="notifications-list"
                data={items}
                keyExtractor={(item) => item.id}
                renderItem={renderItem}
                itemLayoutAnimation={motion ? LinearTransition.duration(180) : undefined}
                ListHeaderComponent={
                    suggestions.items.length > 0 ? (
                        <View testID="hygiene-suggestions">
                            {suggestions.items.map((item) => (
                                <HygieneSuggestionCard
                                    key={item.id}
                                    item={item}
                                    busy={suggestions.actingId === item.id}
                                    onAccept={suggestions.accept}
                                    onDismiss={suggestions.dismiss}
                                />
                            ))}
                        </View>
                    ) : null
                }
                ListEmptyComponent={suggestions.items.length > 0 ? null : empty}
                initialNumToRender={12}
                showsVerticalScrollIndicator={false}
                onScroll={tracked.onScroll}
                scrollEventThrottle={16}
                // Rows that land with no scroll still need a tick to be measured
                // (scroll-tick-coverage guard).
                onContentSizeChange={() => {
                    if (active) notifyScrollTick();
                }}
                contentContainerStyle={{ paddingTop: header.headerHeight + PAGE_CONTENT_GAP, paddingBottom: endClearance }}
            />
        </>
    );
};

export default NotificationsScreen;
