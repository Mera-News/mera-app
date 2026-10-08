import type { PageHeaderBinding } from '@/components/custom/nav/types';
import { Pressable } from '@/components/ui/pressable';
import { Text } from '@/components/ui/text';
import type NotificationModel from '@/lib/database/models/Notification';
import { deleteNotification, markAllRead, observeAll } from '@/lib/database/services/notification-service';
import { getPendingCount, subscribeHygieneChange } from '@/lib/database/services/hygiene-service';
import { hapticLight } from '@/lib/haptics';
import { useListEndClearance } from '@/lib/navigation/tab-bar';
import { useColors } from '@/lib/theme/tokens';
import { notifyScrollTick } from '@/lib/visibility-tick';
import logger from '@/lib/logger';
import { useMotionAllowed } from '@/lib/motion-gate';
import { MaterialIcons } from '@expo/vector-icons';
import { router, type Href } from 'expo-router';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { StyleSheet, View } from 'react-native';
import Animated, { FadeOut, LinearTransition } from 'react-native-reanimated';
import {
    FEEDBACK_REQUEST,
    NOT_KEPT_NOTICE_TYPES,
    tapNotification,
    parseJson,
    resolveText,
} from './notification-actions';
import { PAGE_CONTENT_GAP, PAGE_SIDE_INSET } from '@/components/custom/nav/page-registry';
import { usePageScrollTarget } from '@/components/custom/nav/page-scroll';

/** "now" / "5m" / "2h" / "3d", as the board draws it, in the app language. */
function relativeTime(t: TFunction<'translation'>, date: Date): string {
    const mins = Math.floor((Date.now() - date.getTime()) / 60_000);
    if (mins < 1) return t('notificationCenter.ageNow');
    if (mins < 60) return t('notificationCenter.ageMinutes', { n: mins });
    const hours = Math.floor(mins / 60);
    if (hours < 24) return t('notificationCenter.ageHours', { n: hours });
    return t('notificationCenter.ageDays', { n: Math.floor(hours / 24) });
}

interface NotificationsScreenProps {
    /** The Library tab's shell header (scroll handler, header height). */
    readonly header: PageHeaderBinding;
    /** The visible page of the focused tab. */
    readonly active: boolean;
}

/** The delete control's hit area and glyph (the Settings row icon size). */
const DELETE_FRAME = 44;
const DELETE_GLYPH = 20;
/** One line, at least this tall. */
const ROW_MIN_HEIGHT = 48;
/** The time column's floor: the widest English short form ("23h", "now"). */
const TIME_COLUMN = 32;

/**
 * Feed > Notifications: a plain list in one grouped panel (the Settings list
 * idiom, you/rows), ONE line per row: the age in a fixed column, the title
 * (semibold while unread; the body's first line when there is no title), and
 * a delete at the end. A tap opens the row as before; delete removes it
 * from this phone at once, no confirm. Seeing the page clears both dots (the
 * Library tab's, unless a fact check also lit it, and this pill), and the seen state never leaves this phone. Empty: one
 * line on what lands here, and the way to its settings.
 */
const NotificationsScreen: React.FC<NotificationsScreenProps> = ({ header, active }) => {
    const { t } = useTranslation();
    // The tab's re-tap scrolls this page to the top (nav/page-scroll).
    const listRef = useRef<Animated.FlatList<NotificationModel>>(null);
    usePageScrollTarget(listRef);
    const colors = useColors();
    const endClearance = useListEndClearance();
    // Lite / Reduce Motion: a deleted row leaves at once.
    const motion = useMotionAllowed();
    const [items, setItems] = useState<NotificationModel[]>([]);

    // A hygiene row stamps its count when written, and later sweeps add to the
    // same review list: the live count wins while there is anything left.
    const [hygienePending, setHygienePending] = useState<number | null>(null);
    // Every row's time column is as wide as the widest age laid out so far, so a
    // longer localized short form never clips and the titles still line up.
    const [timeWidth, setTimeWidth] = useState(TIME_COLUMN);
    useEffect(() => {
        let cancelled = false;
        const refresh = () => {
            getPendingCount()
                .then((n) => { if (!cancelled) setHygienePending(n); })
                .catch(() => {});
        };
        refresh();
        const unsubscribe = subscribeHygieneChange(refresh);
        return () => {
            cancelled = true;
            unsubscribe();
        };
    }, []);

    // Newest first. Rows of types no longer kept (written before Y11, alive
    // for 90 days) stay hidden.
    useEffect(() => {
        const sub = observeAll().subscribe((rows) => setItems(rows.filter((n) => !NOT_KEPT_NOTICE_TYPES.has(n.type))));
        return () => sub.unsubscribe();
    }, []);

    // Seeing the page clears the dots: mark read while the page is the one on
    // screen, and again when a row lands while it is. Never on unmount: a
    // warmed neighbour that was never shown must not clear anything. Keyed on
    // "any unread", so the write's own re-emit cannot loop.
    const hasUnread = items.some((n) => n.status === 'unread');
    useEffect(() => {
        if (active && hasUnread) void markAllRead();
    }, [active, hasUnread]);

    const renderItem = useCallback(
        ({ item: n, index }: { item: NotificationModel; index: number }) => {
            const stored = parseJson<Record<string, unknown>>(n.contextJson) ?? undefined;
            const params =
                n.type === 'hygiene' && hygienePending !== null && hygienePending > 0 ? { ...stored, count: hygienePending } : stored;
            // Just the title; a row without one shows its body's first line, so
            // a row is never blank. A feedback request's body is free text:
            // never through t(), whose separators would mangle a question.
            const body = n.type === FEEDBACK_REQUEST ? n.body : resolveText(n.body, params);
            const title = resolveText(n.title, params).trim() || (body ?? '').split('\n')[0].trim();
            const age = relativeTime(t, n.createdAt);
            const unread = n.status === 'unread';
            const first = index === 0;
            const last = index === items.length - 1;
            return (
                <Animated.View
                    exiting={motion ? FadeOut.duration(180) : undefined}
                    style={{
                        marginHorizontal: PAGE_SIDE_INSET,
                        backgroundColor: colors.surface,
                        borderColor: colors.line,
                        borderLeftWidth: 1,
                        borderRightWidth: 1,
                        borderTopWidth: first ? 1 : StyleSheet.hairlineWidth,
                        borderBottomWidth: last ? 1 : 0,
                        borderTopLeftRadius: first ? 16 : 0,
                        borderTopRightRadius: first ? 16 : 0,
                        borderBottomLeftRadius: last ? 16 : 0,
                        borderBottomRightRadius: last ? 16 : 0,
                        flexDirection: 'row',
                        alignItems: 'center',
                    }}
                >
                    <Pressable
                        testID={`notification-row-${n.id}`}
                        onPress={() => {
                            void hapticLight();
                            void tapNotification(n);
                        }}
                        accessibilityRole="button"
                        accessibilityLabel={`${title}, ${age}`}
                        style={{ flex: 1, minHeight: ROW_MIN_HEIGHT, flexDirection: 'row', alignItems: 'center', paddingLeft: 16, gap: 12 }}
                    >
                        {/* Time first, in a shared column so the titles line up. */}
                        <Text
                            style={{ minWidth: timeWidth, color: colors.ink3, fontSize: 13, fontVariant: ['tabular-nums'] }}
                            numberOfLines={1}
                            onLayout={(e) => {
                                const w = Math.ceil(e.nativeEvent.layout.width);
                                setTimeWidth((cur) => Math.max(cur, w));
                            }}
                        >
                            {age}
                        </Text>
                        {/* Unread reads as a semibold title; read is regular. */}
                        <Text
                            testID={unread ? `notification-unread-${n.id}` : undefined}
                            style={{ flex: 1, color: colors.ink, fontSize: 16, fontWeight: unread ? '600' : '400' }}
                            numberOfLines={1}
                        >
                            {title}
                        </Text>
                    </Pressable>
                    {/* A sibling of the row's press area, never inside it, so a
                        delete never opens the row. */}
                    <Pressable
                        testID={`notification-delete-${n.id}`}
                        onPress={() => {
                            void hapticLight();
                            deleteNotification(n.id).catch((err: unknown) =>
                                logger.captureException(err, { tags: { component: 'NotificationsScreen', method: 'delete' } }),
                            );
                        }}
                        accessibilityRole="button"
                        accessibilityLabel={t('common.delete')}
                        // The 20pt glyph centred 16pt from the edge, as a Settings row.
                        style={{ width: DELETE_FRAME, height: DELETE_FRAME, marginRight: 16 - (DELETE_FRAME - DELETE_GLYPH) / 2, alignItems: 'center', justifyContent: 'center' }}
                    >
                        <MaterialIcons name="delete-outline" size={DELETE_GLYPH} color={colors.ink3} />
                    </Pressable>
                </Animated.View>
            );
        },
        [hygienePending, colors, t, items.length, motion, timeWidth],
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
        <Animated.FlatList
            ref={listRef}
            testID="notifications-list"
            data={items}
            keyExtractor={(item) => item.id}
            renderItem={renderItem}
            itemLayoutAnimation={motion ? LinearTransition.duration(180) : undefined}
            ListEmptyComponent={empty}
            initialNumToRender={12}
            showsVerticalScrollIndicator={false}
            onScroll={header.scrollHandler}
            scrollEventThrottle={16}
            // Rows that land with no scroll still need a tick to be measured
            // (scroll-tick-coverage guard).
            onContentSizeChange={() => {
                if (active) notifyScrollTick();
            }}
            contentContainerStyle={{ paddingTop: header.headerHeight + PAGE_CONTENT_GAP, paddingBottom: endClearance }}
        />
    );
};

export default NotificationsScreen;
