import type { PageHeaderBinding } from '@/components/custom/nav/types';
import { Pressable } from '@/components/ui/pressable';
import { Text } from '@/components/ui/text';
import type NotificationModel from '@/lib/database/models/Notification';
import { markAllRead, observeAll } from '@/lib/database/services/notification-service';
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
import { router, type Href } from 'expo-router';
import React, { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { View } from 'react-native';
import Animated from 'react-native-reanimated';
import {
    actionLabel,
    FEEDBACK_REQUEST,
    NOT_KEPT_NOTICE_TYPES,
    openNotification,
    parseJson,
    resolveText,
    runNotificationAction,
    type NotificationAction,
} from './notification-actions';

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
    /** The You tab's shell header (title row, scroll handler). */
    readonly header: PageHeaderBinding;
    /** The visible page of the focused tab. */
    readonly active: boolean;
}

/**
 * You > Notifications (FinalInbox #4, #5): only things that need you, each
 * with its age and ONE button. Seeing the page clears both dots (the You tab
 * and this pill), and the seen state never leaves this phone. Empty: one
 * line on what lands here, and the way to its settings.
 */
const NotificationsScreen: React.FC<NotificationsScreenProps> = ({ header, active }) => {
    const { t } = useTranslation();
    const colors = useColors();
    const endClearance = useListEndClearance();
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
        ({ item: n }: { item: NotificationModel }) => {
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
            const action = (parseJson<NotificationAction[]>(n.actionsJson) ?? [])[0];
            const age = relativeTime(n.createdAt);
            return (
                <View
                    style={{ marginHorizontal: 14, marginBottom: 10, borderRadius: 16, borderWidth: 1, borderColor: colors.line, backgroundColor: colors.surface, padding: 16, gap: 10 }}
                >
                    <Pressable
                        testID={`notification-row-${n.id}`}
                        onPress={() => {
                            void hapticLight();
                            void openNotification(n);
                        }}
                        accessibilityRole="button"
                        // The button is a separate stop on its own; the row reads once.
                        accessibilityLabel={[title, body, status, age].filter(Boolean).join(', ')}
                        style={{ gap: 6 }}
                    >
                        <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: 8 }}>
                            <Text style={{ flex: 1, color: colors.ink, fontSize: 16, fontWeight: '600' }} numberOfLines={2}>
                                {title}
                            </Text>
                            <Text style={{ color: colors.ink3, fontSize: 13 }}>{age}</Text>
                        </View>
                        {body ? (
                            <Text style={{ color: colors.ink2, fontSize: 14, lineHeight: 20 }} numberOfLines={3}>
                                {body}
                            </Text>
                        ) : null}
                        {status ? (
                            <Text testID={`notification-status-${n.id}`} style={{ color: colors.accentText, fontSize: 13, fontWeight: '600' }}>
                                {status}
                            </Text>
                        ) : null}
                    </Pressable>
                    {action ? (
                        <Pressable
                            testID={`notification-action-${n.id}`}
                            onPress={() => {
                                void hapticLight();
                                void runNotificationAction(n, action);
                            }}
                            accessibilityRole="button"
                            accessibilityLabel={actionLabel(action)}
                            style={{ alignSelf: 'flex-start', minHeight: 44, justifyContent: 'center' }}
                        >
                            <View style={{ borderRadius: 999, borderWidth: 1, borderColor: colors.accent, paddingHorizontal: 14, paddingVertical: 7 }}>
                                <Text style={{ color: colors.accentText, fontSize: 14, fontWeight: '600' }}>{actionLabel(action)}</Text>
                            </View>
                        </Pressable>
                    ) : null}
                </View>
            );
        },
        [hygienePending, feedbackRequests, colors, t],
    );

    const empty = (
        <View testID="notifications-empty" style={{ marginHorizontal: 18, gap: 6 }}>
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
            testID="notifications-list"
            data={items}
            keyExtractor={(item) => item.id}
            renderItem={renderItem}
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
            contentContainerStyle={{ paddingTop: header.headerHeight + 8, paddingBottom: endClearance }}
        />
    );
};

export default NotificationsScreen;
