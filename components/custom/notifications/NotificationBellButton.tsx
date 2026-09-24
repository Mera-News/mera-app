import HeaderIconButton from '@/components/custom/for-you/HeaderIconButton';
import { Text } from '@/components/ui/text';
import { observeUnreadCount } from '@/lib/database/services/notification-service';
import { hapticLight } from '@/lib/haptics';
import { setBellAnchor } from '@/lib/notifications/bell-anchor';
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
 * pushes `/logged-in/notifications` on tap. It IS the shared HeaderIconButton
 * (owner: "the same size and style as the search icon in Explore"): 44pt
 * frame, white 24pt glyph, no chip. The unread count is a badge on the glyph
 * and is read in the button's own label, so the badge is hidden from
 * accessibility.
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

    const label = t('notificationCenter.bellA11y');
    return (
        <HeaderIconButton
            ref={btnRef as never}
            icon="notifications-none"
            onPress={onPress}
            onLayout={measureBell}
            accessibilityLabel={
                count > 0 ? `${label}, ${t('trackedStories.updatesBadge', { count })}` : label
            }
            testID="feed-notification-bell"
        >
            {count > 0 ? (
                <View
                    className="absolute items-center justify-center"
                    testID="feed-notification-bell-badge"
                    // Read in the button's label instead: one element.
                    accessibilityElementsHidden
                    importantForAccessibility="no-hide-descendants"
                    // Anchored to the 24pt glyph's top-right corner inside the
                    // 44pt frame (the glyph spans 10..34). minHeight, not
                    // height: the count scales and a hard 16pt box clipped it.
                    style={{
                        top: 4,
                        right: 4,
                        minWidth: 16,
                        minHeight: 16,
                        borderRadius: 8,
                        paddingHorizontal: 3,
                        backgroundColor: ACCENT,
                    }}
                >
                    <Text className="text-black font-bold" size="2xs" scaleTier="chrome">
                        {count > 99 ? '99+' : count}
                    </Text>
                </View>
            ) : null}
        </HeaderIconButton>
    );
};

export default NotificationBellButton;
