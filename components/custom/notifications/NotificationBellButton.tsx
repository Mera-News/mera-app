import { Pressable } from '@/components/ui/pressable';
import { Text } from '@/components/ui/text';
import { observeUnreadCount } from '@/lib/database/services/notification-service';
import { hapticLight } from '@/lib/haptics';
import { setBellAnchor } from '@/lib/notifications/bell-anchor';
import { MaterialIcons } from '@expo/vector-icons';
import { router } from 'expo-router';
import React, { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { View } from 'react-native';

const ACCENT = '#EDA77E';

type MeasurableNode = {
    measureInWindow?: (
        cb: (x: number, y: number, width: number, height: number) => void,
    ) => void;
};

/**
 * Inline header bell — the notifications entry point for the For You and
 * Explore tabs (app-rethink wave). Replaces the absolutely-positioned
 * NotificationBellOverlay: this is a normal in-flow header element that
 * pushes `/logged-in/notifications` on tap, styled to match the other header
 * icon buttons on each screen (p-3 rounded-full border border-primary-500).
 *
 * Still registers the bell's on-screen center via bell-anchor.ts so the
 * "notified" toast (NotifiedToast, hosted globally in app_container/_layout)
 * keeps flying toward it.
 */
const NotificationBellButton: React.FC = () => {
    const { t } = useTranslation();
    const [count, setCount] = useState(0);
    const btnRef = useRef<MeasurableNode | null>(null);

    // Reactive unread count → drives the badge.
    useEffect(() => {
        const sub = observeUnreadCount().subscribe(setCount);
        return () => sub.unsubscribe();
    }, []);

    // Register the bell's on-screen center so the "notified" toast can fly to it.
    const measureBell = () => {
        const node = btnRef.current;
        if (!node || typeof node.measureInWindow !== 'function') return;
        try {
            node.measureInWindow((x, y, w, h) => {
                setBellAnchor({ x: x + w / 2, y: y + h / 2 });
            });
        } catch {
            // measureInWindow can throw if the node is detached mid-layout.
        }
    };

    const onPress = () => {
        void hapticLight();
        router.push('/logged-in/notifications');
    };

    return (
        <Pressable
            ref={btnRef as never}
            onLayout={measureBell}
            onPress={onPress}
            hitSlop={12}
            accessibilityRole="button"
            accessibilityLabel={t('notificationCenter.bellA11y')}
            className="p-3 rounded-full border border-primary-500 bg-transparent"
        >
            <MaterialIcons name="notifications-none" size={22} color={ACCENT} />
            {count > 0 ? (
                <View
                    className="absolute bg-primary-500 items-center justify-center"
                    style={{
                        top: -2,
                        right: -2,
                        minWidth: 16,
                        height: 16,
                        borderRadius: 8,
                        paddingHorizontal: 3,
                    }}
                >
                    <Text className="text-white font-bold" size="2xs">
                        {count > 99 ? '99+' : count}
                    </Text>
                </View>
            ) : null}
        </Pressable>
    );
};

export default NotificationBellButton;
