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
import { getPendingCount, subscribeHygieneChange } from '@/lib/database/services/hygiene-service';
import { hapticLight } from '@/lib/haptics';
import logger from '@/lib/logger';
import { useFloatingChatStore } from '@/lib/stores/floating-chat-store';
import { MaterialIcons } from '@expo/vector-icons';
import { router } from 'expo-router';
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { FlatList, StyleSheet, View } from 'react-native';

const ACCENT = '#EDA77E';

type NotificationAction = { id: string; labelKey?: string; label?: string };

/** Written by lib/fact-check/fact-check-settled for a check this device asked for. */
const FACT_CHECK_DONE = 'fact_check_done';

/** Default leading icon per notification type when the row has no explicit icon. */
const ROW_ICON = 22;
const GLYPH_HIDDEN = {
    accessible: false,
    accessibilityElementsHidden: true,
    importantForAccessibility: 'no-hide-descendants',
} as const;
/** p-2 at NativeWind's 14pt rem, numeric so the ring size is known here. */
const CLEAR_PAD = 7;
const CLEAR_GLYPH = 20;
const CLEAR_RING = CLEAR_GLYPH + 2 * CLEAR_PAD + 2;
const CLEAR_TARGET = 44;
const CLEAR_FRAME = {
    width: CLEAR_TARGET,
    height: CLEAR_TARGET,
    margin: -(CLEAR_TARGET - CLEAR_RING) / 2,
    alignItems: 'center',
    justifyContent: 'center',
} as const;

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
        case FACT_CHECK_DONE:
            return 'fact-check';
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
    /**
     * The cleanups waiting RIGHT NOW. A hygiene row stamps its count when it is
     * written, and later sweeps add to the same review list, so the row said
     * "1 cleanup" over a list of 2 (audit F47). The live count wins whenever
     * there is anything left to review.
     */
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

    /**
     * A finished fact check opens its article, never the chat. The destination
     * is the data layer's `resolveNotificationRoute`, the same one an OS tap
     * uses, so the two can never disagree. Lazy: notification-service pulls in
     * expo-notifications at module scope.
     */
    const openFactCheck = useCallback(async (n: NotificationModel) => {
        const context = parseJson<Record<string, unknown>>(n.contextJson) ?? {};
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const { resolveNotificationRoute } = require('@/lib/notification-service') as typeof import('@/lib/notification-service');
        const href = await resolveNotificationRoute({ ...context, type: FACT_CHECK_DONE });
        router.push(href);
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
        if (n.type === FACT_CHECK_DONE) {
            await openFactCheck(n);
            return;
        }
        const hasFollowUp = Boolean(n.contextJson) || Boolean(n.actionsJson);
        if (!hasFollowUp) return; // informational → mark read only
        const params =
            parseJson<Record<string, unknown>>(n.contextJson) ?? undefined;
        openChatWith(resolveText(n.body, params));
    }, [openChatWith, openFactCheck, resolveText]);

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
        if (action.id === 'open-fact-check') {
            await openFactCheck(n);
            return;
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
    }, [openChatWith, openFactCheck, resolveText]);

    const renderItem = useCallback(({ item: n }: { item: NotificationModel }) => {
        const stored = parseJson<Record<string, unknown>>(n.contextJson) ?? undefined;
        const params =
            n.type === 'hygiene' && hygienePending !== null && hygienePending > 0
                ? { ...stored, count: hygienePending }
                : stored;
        const title = resolveText(n.title, params);
        const body = resolveText(n.body, params);
        const icon = (n.icon as keyof typeof MaterialIcons.glyphMap) || iconForType(n.type);
        const actions = parseJson<NotificationAction[]>(n.actionsJson) ?? [];

        // The icon is drawn OVER the row, not inside it: a glyph inside the
        // accessible row led its label ("<glyph>, Fact check ready", captured).
        // A 22pt spacer holds its column; pointerEvents none lets a tap on the
        // icon fall through to the row beneath.
        return (
            <View>
            <Pressable
                onPress={() => onRowPress(n)}
                accessibilityRole="button"
                className="flex-row px-4 py-3 border-b border-gray-800"
            >
                <View style={{ width: ROW_ICON }} />
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
            <View pointerEvents="none" {...GLYPH_HIDDEN} className="absolute left-4 top-3">
                <MaterialIcons name={icon} size={ROW_ICON} color={ACCENT} style={{ marginTop: 2 }} {...GLYPH_HIDDEN} />
            </View>
            </View>
        );
    }, [onRowPress, onChipPress, resolveText, hygienePending]);

    const keyExtractor = useCallback((item: NotificationModel) => item.id, []);

    return (
        // No opaque fill: the route mounts AbstractGradientBackdrop OUTSIDE
        // its SafeAreaView, so the page background spans the safe areas.
        <Box className="flex-1">
            <DrillDownHeader
                title={t('notificationCenter.title')}
                onBack={onBack}
                rightAction={
                    items.length > 0 ? (
                        // A numeric 44pt frame pulled back to the 36pt ring by
                        // negative margins holds the ring, with a childless
                        // labelled button filling the frame (glyph rule; a
                        // hitSlop target measured as the ring on device).
                        <View testID="notifications-clear-all-frame" style={CLEAR_FRAME}>
                            <View
                                pointerEvents="none"
                                {...GLYPH_HIDDEN}
                                className="rounded-full border-primary-500"
                                style={{ padding: CLEAR_PAD, borderWidth: 1 }}
                            >
                                <MaterialIcons name="delete-sweep" size={CLEAR_GLYPH} color={ACCENT} {...GLYPH_HIDDEN} />
                            </View>
                            <Pressable
                                testID="notifications-clear-all"
                                onPress={() => void clearAll()}
                                accessibilityRole="button"
                                accessibilityLabel={t('notificationCenter.clearAll')}
                                style={StyleSheet.absoluteFill}
                            />
                        </View>
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
