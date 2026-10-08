import type { PageHeaderBinding } from '@/components/custom/nav/types';
import { Pressable } from '@/components/ui/pressable';
import { Text } from '@/components/ui/text';
import type NotificationModel from '@/lib/database/models/Notification';
import { deleteNotification, markAllRead, observeAll } from '@/lib/database/services/notification-service';
import { getPendingCount, subscribeHygieneChange } from '@/lib/database/services/hygiene-service';
import {
    isFeedbackRequestEnded,
    readFeedbackRequestsState,
    subscribeFeedbackRequestsState,
    type FeedbackRequestsState,
} from '@/lib/feedback-requests/feedback-request-state';
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

/** "now" / "5m" / "2h" / "3d", as the board draws it. */
function relativeTime(date: Date): string {
    const mins = Math.floor((Date.now() - date.getTime()) / 60_000);
    if (mins < 1) return 'now';
    if (mins < 60) return `${mins}m`;
    const hours = Math.floor(mins / 60);
    if (hours < 24) return `${hours}h`;
    return `${Math.floor(hours / 24)}d`;
}

interface NotificationsScreenProps {
    /** The Library tab's shell header (scroll handler, header height). */
    readonly header: PageHeaderBinding;
    /** The visible page of the focused tab. */
    readonly active: boolean;
}

/** The delete control's hit area. */
const DELETE_FRAME = 44;

/**
 * Feed > Notifications: a plain list in one grouped panel (the Settings list
 * idiom, you/rows): an unread dot, the title, a two-line preview and its age,
 * and a delete at the end. A tap opens the row as before; delete removes it
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

    // Feedback-request rows read their question and Answered / Closed state
    // from the device state row, kept live so a submit shows at once.
    const [feedbackRequests, setFeedbackRequests] = useState<FeedbackRequestsState>({});
    useEffect(() => {
        let cancelled = false;
        const refresh = () => {
            readFeedbackRequestsState()
                .then((s) => { if (!cancelled) setFeedbackRequests(s); })
                .catch(() => {});
        };
        refresh();
        const unsubscribe = subscribeFeedbackRequestsState(refresh);
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
            const title = resolveText(n.title, params);
            // A feedback request's body is free text: never through t(), whose
            // key and namespace separators would mangle a question.
            let body: string;
            let status: string | null = null;
            if (n.type === FEEDBACK_REQUEST) {
                const id = stored?.feedbackRequestId;
                const entry = typeof id === 'string' ? feedbackRequests[id] : undefined;
                body = entry?.question ?? n.body;
                const endsAt = entry?.endsAt ?? (typeof stored?.endsAt === 'number' ? stored.endsAt : null);
                if (entry?.answeredAt !== undefined || n.status === 'actioned') status = t('feedbackRequest.drawerAnswered');
                else if (endsAt !== null && isFeedbackRequestEnded({ endsAt })) status = t('feedbackRequest.drawerClosed');
            } else {
                body = resolveText(n.body, params);
            }
            const age = relativeTime(n.createdAt);
            const unread = n.status === 'unread';
            const first = index === 0;
            const last = index === items.length - 1;
            const preview = [body, status].filter(Boolean).join(' · ');
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
                        accessibilityLabel={[title, preview, age].filter(Boolean).join(', ')}
                        style={{ flex: 1, flexDirection: 'row', alignItems: 'flex-start', paddingVertical: 12, paddingLeft: 16, gap: 10 }}
                    >
                        {/* The unread dot keeps its column, so titles line up. */}
                        <View style={{ width: 8, paddingTop: 7 }}>
                            {unread ? (
                                <View testID={`notification-unread-${n.id}`} style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: colors.accentMark }} />
                            ) : null}
                        </View>
                        <View style={{ flex: 1, gap: 3 }}>
                            <View style={{ flexDirection: 'row', alignItems: 'baseline', gap: 8 }}>
                                <Text style={{ flex: 1, color: colors.ink, fontSize: 16, fontWeight: '600' }} numberOfLines={1}>
                                    {title}
                                </Text>
                                <Text style={{ color: colors.ink3, fontSize: 13 }}>{age}</Text>
                            </View>
                            {preview ? (
                                <Text testID={`notification-preview-${n.id}`} style={{ color: colors.ink2, fontSize: 14, lineHeight: 19 }} numberOfLines={2}>
                                    {preview}
                                </Text>
                            ) : null}
                        </View>
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
                        style={{ width: DELETE_FRAME, height: DELETE_FRAME, marginRight: 4, alignItems: 'center', justifyContent: 'center' }}
                    >
                        <MaterialIcons name="delete-outline" size={22} color={colors.ink3} />
                    </Pressable>
                </Animated.View>
            );
        },
        [hygienePending, feedbackRequests, colors, t, items.length, motion],
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
