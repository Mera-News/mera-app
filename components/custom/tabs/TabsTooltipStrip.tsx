import { Button, ButtonText } from '@/components/ui/button';
import { HStack } from '@/components/ui/hstack';
import { Text } from '@/components/ui/text';
import { VStack } from '@/components/ui/vstack';
import { getSetting, setSetting } from '@/lib/database/services/setting-service';
import logger from '@/lib/logger';
import { TAB_BAR_HEIGHT } from '@/lib/navigation/tab-bar';
import { MaterialIcons } from '@expo/vector-icons';
import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AccessibilityInfo, StyleSheet } from 'react-native';
import Animated, { FadeIn, FadeOut } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

/** Settings KV flag (setting-service get/set) gating the one-time strip. */
const TOOLTIP_SEEN_KEY = 'tabs_tooltip_seen';
const ACCENT = 'rgb(231, 138, 83)';

// All five bottom tabs, in tab order (browse revealed Wave 8, around/Explore
// revealed Wave 10 — see app_container/_layout.tsx). `as const` keeps labelKey
// as a literal string type so it type-checks against react-i18next's typed
// `t()` keys (lib/i18n/types.ts).
const VISIBLE_TABS = [
    { icon: 'style', labelKey: 'tabs.browse' },
    { icon: 'home', labelKey: 'tabs.forYou' },
    { icon: 'explore', labelKey: 'tabs.around' },
    { icon: 'person', labelKey: 'tabs.profile' },
    { icon: 'settings', labelKey: 'tabs.settings' },
] as const satisfies readonly { icon: keyof typeof MaterialIcons.glyphMap; labelKey: string }[];

/**
 * First-run, one-time dismissible strip naming the visible bottom tabs.
 * Gated by the `tabs_tooltip_seen` settings flag (existing setting-service
 * get/set KV pattern — same store notification-hour-wheel etc. use). Mounted
 * inside app_container/_layout.tsx so it renders above the tab bar on first
 * mount of the tab shell, once per install (not per session).
 *
 * Entrance/exit animation is skipped when the OS reduce-motion setting is on
 * (AccessibilityInfo.isReduceMotionEnabled) — the strip still appears/
 * disappears, just without the fade.
 */
const TabsTooltipStrip: React.FC = () => {
    const { t } = useTranslation();
    const insets = useSafeAreaInsets();
    const [visible, setVisible] = useState(false);
    const [reduceMotion, setReduceMotion] = useState(false);

    useEffect(() => {
        let cancelled = false;

        AccessibilityInfo.isReduceMotionEnabled()
            .then((enabled) => {
                if (!cancelled) setReduceMotion(enabled);
            })
            .catch(() => { /* default: motion enabled */ });

        getSetting(TOOLTIP_SEEN_KEY)
            .then((value) => {
                if (!cancelled && !value) setVisible(true);
            })
            .catch((err: unknown) => {
                logger.captureException(err, {
                    tags: { component: 'TabsTooltipStrip', method: 'getSetting' },
                });
            });

        return () => { cancelled = true; };
    }, []);

    const dismiss = () => {
        setVisible(false);
        setSetting(TOOLTIP_SEEN_KEY, '1').catch((err: unknown) => {
            logger.captureException(err, {
                tags: { component: 'TabsTooltipStrip', method: 'setSetting' },
            });
        });
    };

    if (!visible) return null;

    return (
        <Animated.View
            entering={reduceMotion ? undefined : FadeIn.duration(250)}
            exiting={reduceMotion ? undefined : FadeOut.duration(200)}
            style={[styles.container, { bottom: TAB_BAR_HEIGHT + insets.bottom + 10 }]}
            pointerEvents="box-none"
        >
            <VStack className="bg-gray-900 border border-gray-700 rounded-2xl px-4 py-3 mx-4" space="sm">
                {VISIBLE_TABS.map((tab) => (
                    <HStack key={tab.labelKey} className="items-center" space="md">
                        <MaterialIcons name={tab.icon} size={18} color={ACCENT} />
                        <Text className="text-white text-sm">{t(tab.labelKey)}</Text>
                    </HStack>
                ))}
                <Button size="sm" className="mt-1 self-end bg-primary-400" onPress={dismiss}>
                    <ButtonText>{t('tabs.gotIt')}</ButtonText>
                </Button>
            </VStack>
        </Animated.View>
    );
};

const styles = StyleSheet.create({
    container: {
        position: 'absolute',
        left: 0,
        right: 0,
    },
});

export default TabsTooltipStrip;
