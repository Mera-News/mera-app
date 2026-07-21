import DrillDownHeader from '@/components/custom/config-panel/DrillDownHeader';
import MeraLogo from '@/components/custom/MeraLogo';
import { Box } from '@/components/ui/box';
import { HStack } from '@/components/ui/hstack';
import { Pressable } from '@/components/ui/pressable';
import { Text } from '@/components/ui/text';
import { VStack } from '@/components/ui/vstack';
import type NotificationModel from '@/lib/database/models/Notification';
import {
    clearAll,
    markActioned,
    markAllRead,
    markRead,
    observeAll,
} from '@/lib/database/services/notification-service';
import { hapticLight } from '@/lib/haptics';
import logger from '@/lib/logger';
import { useFloatingChatStore } from '@/lib/stores/floating-chat-store';
import { MaterialIcons } from '@expo/vector-icons';
import { router } from 'expo-router';
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { FlatList, View } from 'react-native';

const ACCENT = '#EDA77E';

type NotificationAction = { id: string; labelKey?: string; label?: string };

/** Default leading icon per notification type when the row has no explicit icon. */
function iconForType(type: string): keyof typeof MaterialIcons.glyphMap {
    switch (type) {
        case 'calibration':
            return 'tune';
        case 'hygiene':
            return 'cleaning-services';
        case 'optimisation_plan':
            return 'auto-fix-high';
        case 'migration_done':
            return 'auto-awesome';
        case 'sync_event':
            return 'sync-problem';
        case 'feed_info':
            return 'info';
        default:
            return 'notifications';
    }
}

/** "just now" / "Nm" / "Nh" / "Nd" from a Date. English inline is acceptable. */
function relativeTime(date: Date): string {
    const diffMs = Date.now() - date.getTime();
    const mins = Math.floor(diffMs / 60_000);
    if (mins < 1) return 'just now';
    if (mins < 60) return `${mins}m`;
    const hours = Math.floor(mins / 60);
    if (hours < 24) return `${hours}h`;
    const days = Math.floor(hours / 24);
    return `${days}d`;
}

/** Safe JSON.parse → object; null on failure/empty. */
function parseJson<T>(raw: string | null): T | null {
    if (!raw) return null;
    try {
        return JSON.parse(raw) as T;
    } catch {
        return null;
    }
}

interface NotificationsScreenProps {
    readonly onBack: () => void;
}

/**
 * Pushed notifications screen (app-rethink wave). Replaces the
 * NotificationPanel slide-over modal — same WatermelonDB observable data
 * source + Q.take(100) cap (see notification-service.observeAll) and the same
 * row rendering/interaction logic (mark-read, chip actions, chat hand-off),
 * ported here as a virtualized FlatList instead of a ScrollView + .map.
 */
const NotificationsScreen: React.FC<NotificationsScreenProps> = ({ onBack }) => {
    const { t } = useTranslation();
    const [items, setItems] = useState<NotificationModel[]>([]);

    // i18n-key-or-raw resolver: tries t(key, params) and falls back to the raw
    // string when the key is unknown (i18next returns the key itself on a miss,
    // which for freeform agent text IS the display text).
    const resolveText = useMemo(
        () =>
            (key: string, params?: Record<string, unknown>): string => {
                if (!key) return '';
                // Cast: `t` is strongly typed to known keys, but notification
                // title/body may be dynamic keys OR freeform text (agent rows).
                const resolved = (
                    t as unknown as (k: string, o?: Record<string, unknown>) => string
                )(key, params ?? {});
                return typeof resolved === 'string' ? resolved : key;
            },
        [t],
    );

    // Reactive newest-first list — drives the screen body.
    useEffect(() => {
        const sub = observeAll().subscribe(setItems);
        return () => sub.unsubscribe();
    }, []);

    // Unread dots stay visible while the user reads the list; the bell badge
    // (observeUnreadCount) is cleared only on leave — mark everything read here.
    useEffect(() => {
        return () => {
            void markAllRead();
        };
    }, []);

    /** Opens the floating Mera chat pre-staged with a synthesized message. */
    const openChatWith = useCallback((message: string) => {
        useFloatingChatStore
            .getState()
            .openArticleFeedback({ kind: 'persona' }, message);
    }, []);

    const onRowPress = useCallback(async (n: NotificationModel) => {
        void hapticLight();
        try {
            await markRead(n.id);
        } catch (err) {
            logger.captureException(err, {
                tags: { component: 'NotificationsScreen', method: 'markRead' },
            });
        }
        const hasFollowUp = Boolean(n.contextJson) || Boolean(n.actionsJson);
        if (!hasFollowUp) return; // informational → mark read only
        const params =
            parseJson<Record<string, unknown>>(n.contextJson) ?? undefined;
        openChatWith(resolveText(n.body, params));
    }, [openChatWith, resolveText]);

    // wave 9 wires real deterministic executors keyed on action.id; here we
    // mark the notification actioned and pre-stage the chat with the right
    // context. The `recalibrate` chip (calibration notifications, M-P5c) opens
    // the floating Mera chat pre-staged with the calibration invitation so the
    // in-chat "Recalibrate now" affordance can call
    // calibrationService.runCalibration() on explicit confirm.
    const onChipPress = useCallback(async (n: NotificationModel, action: NotificationAction) => {
        void hapticLight();
        try {
            await markActioned(n.id);
        } catch (err) {
            logger.captureException(err, {
                tags: { component: 'NotificationsScreen', method: 'markActioned' },
            });
        }
        if (action.id === 'recalibrate') {
            // Stage the calibration context (not the raw chip label) into chat.
            const params = parseJson<Record<string, unknown>>(n.contextJson) ?? undefined;
            openChatWith(resolveText('calibration.chatIntro', params));
            return;
        }
        if (action.id === 'review-hygiene') {
            // Deterministic review sheet (no chat, no LLM) — push the dedicated
            // hygiene-review route.
            router.push('/logged-in/hygiene-review');
            return;
        }
        if (action.id === 'review-plan') {
            // Round-4 C5 — open Mera chat showing the pending daily tune-up plan.
            useFloatingChatStore.getState().openOptimisationPlan();
            return;
        }
        const chipLabel = action.labelKey
            ? resolveText(action.labelKey)
            : action.label ?? action.id;
        openChatWith(chipLabel);
    }, [openChatWith, resolveText]);

    const renderItem = useCallback(({ item: n }: { item: NotificationModel }) => {
        const params = parseJson<Record<string, unknown>>(n.contextJson) ?? undefined;
        const title = resolveText(n.title, params);
        const body = resolveText(n.body, params);
        const icon = (n.icon as keyof typeof MaterialIcons.glyphMap) || iconForType(n.type);
        const actions = parseJson<NotificationAction[]>(n.actionsJson) ?? [];

        return (
            <Pressable
                onPress={() => onRowPress(n)}
                accessibilityRole="button"
                className="flex-row px-4 py-3 border-b border-gray-800"
            >
                <MaterialIcons name={icon} size={22} color={ACCENT} style={{ marginTop: 2 }} />
                <VStack className="flex-1 ml-3" space="xs">
                    <HStack className="items-start justify-between">
                        <Text className="text-white font-semibold flex-1" numberOfLines={2}>
                            {title}
                        </Text>
                        {n.status === 'unread' ? (
                            <View
                                className="bg-primary-500 ml-2 mt-1"
                                style={{ width: 8, height: 8, borderRadius: 4 }}
                            />
                        ) : null}
                    </HStack>
                    {body ? (
                        <Text className="text-sm" style={{ color: 'rgb(163,163,163)' }} numberOfLines={3}>
                            {body}
                        </Text>
                    ) : null}
                    {actions.length > 0 ? (
                        <HStack className="flex-wrap mt-1">
                            {actions.map((a) => (
                                <Pressable
                                    key={a.id}
                                    onPress={() => onChipPress(n, a)}
                                    accessibilityRole="button"
                                    className="border border-primary-500 rounded-full px-3 py-1 mr-2 mb-1"
                                >
                                    <Text className="text-xs" style={{ color: ACCENT }}>
                                        {a.labelKey ? resolveText(a.labelKey) : a.label ?? a.id}
                                    </Text>
                                </Pressable>
                            ))}
                        </HStack>
                    ) : null}
                    <Text className="text-xs" style={{ color: 'rgb(115,115,115)' }}>
                        {relativeTime(n.createdAt)}
                    </Text>
                </VStack>
            </Pressable>
        );
    }, [onRowPress, onChipPress, resolveText]);

    const keyExtractor = useCallback((item: NotificationModel) => item.id, []);

    return (
        <Box className="flex-1 bg-black">
            <DrillDownHeader
                title={t('notificationCenter.title')}
                onBack={onBack}
                rightAction={
                    items.length > 0 ? (
                        <Pressable
                            onPress={() => void clearAll()}
                            hitSlop={10}
                            accessibilityRole="button"
                            accessibilityLabel={t('notificationCenter.clearAll')}
                            className="p-2 rounded-full border border-primary-500"
                        >
                            <MaterialIcons name="delete-sweep" size={20} color={ACCENT} />
                        </Pressable>
                    ) : undefined
                }
            />
            {items.length === 0 ? (
                <VStack className="flex-1 items-center justify-center px-6" space="md">
                    <MeraLogo size={72} />
                    <Text className="text-center" style={{ color: 'rgb(163,163,163)' }}>
                        {t('notificationCenter.empty')}
                    </Text>
                </VStack>
            ) : (
                <FlatList
                    data={items}
                    keyExtractor={keyExtractor}
                    renderItem={renderItem}
                    initialNumToRender={12}
                    showsVerticalScrollIndicator={false}
                    contentContainerStyle={{ paddingBottom: 48 }}
                />
            )}
        </Box>
    );
};

export default NotificationsScreen;
