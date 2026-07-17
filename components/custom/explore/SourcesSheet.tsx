import SourcesTabContent from '@/components/custom/config-panel/SourcesTabContent';
import { Heading } from '@/components/ui/heading';
import { HStack } from '@/components/ui/hstack';
import { Modal, ModalBackdrop } from '@/components/ui/modal';
import { Pressable } from '@/components/ui/pressable';
import { VStack } from '@/components/ui/vstack';
import { MaterialIcons } from '@expo/vector-icons';
import React, { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AccessibilityInfo, Dimensions, View } from 'react-native';
import Animated, { useAnimatedStyle, useSharedValue, withTiming } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

const ACCENT = '#EDA77E';

interface SourcesSheetProps {
    readonly open: boolean;
    readonly onClose: () => void;
}

/**
 * Bottom-anchored sheet hosting the existing browse-only Sources drill-down
 * (SourcesTabContent → SourcesL1CountryList: country → publisher → feeds). Built
 * as a Modal (backdrop + dismiss + topmost) with an absolutely bottom-pinned
 * Animated.View that slides up on open. Reduce-motion → instant (mirrors
 * NotificationPanel). Opened from the Explore FAB and the header Sources action;
 * the standalone `/logged-in/sources` route and the Settings row stay as
 * redundant entries.
 */
const SourcesSheet: React.FC<SourcesSheetProps> = ({ open, onClose }) => {
    const { t } = useTranslation();
    const insets = useSafeAreaInsets();
    const [reduceMotion, setReduceMotion] = useState(false);

    const sheetHeight = useMemo(() => Math.round(Dimensions.get('window').height * 0.85), []);
    const translateY = useSharedValue(sheetHeight);

    useEffect(() => {
        let cancelled = false;
        AccessibilityInfo.isReduceMotionEnabled()
            .then((enabled) => {
                if (!cancelled) setReduceMotion(enabled);
            })
            .catch(() => {
                /* default: motion enabled */
            });
        return () => {
            cancelled = true;
        };
    }, []);

    // Slide up from the bottom when opened. Reduce-motion → instant.
    useEffect(() => {
        if (!open) return;
        translateY.value = reduceMotion ? 0 : withTiming(0, { duration: 250 });
    }, [open, reduceMotion, translateY, sheetHeight]);

    const animatedStyle = useAnimatedStyle(() => ({
        transform: [{ translateY: translateY.value }],
    }));

    return (
        <Modal isOpen={open} onClose={onClose} size="full">
            <ModalBackdrop />
            <Animated.View
                style={[
                    {
                        position: 'absolute',
                        left: 0,
                        right: 0,
                        bottom: 0,
                        height: sheetHeight,
                    },
                    animatedStyle,
                ]}
                className="bg-gray-950 border-t border-gray-800 rounded-t-2xl overflow-hidden"
                pointerEvents="auto"
            >
                <VStack className="flex-1">
                    {/* Drag handle */}
                    <View className="items-center pt-2 pb-1">
                        <View className="bg-gray-700 rounded-full" style={{ width: 40, height: 4 }} />
                    </View>
                    {/* Header */}
                    <HStack className="items-center justify-between px-4 pb-3 border-b border-gray-800">
                        <Heading size="lg" className="text-white">
                            {t('explore.sheetTitle')}
                        </Heading>
                        <Pressable
                            onPress={onClose}
                            hitSlop={12}
                            accessibilityRole="button"
                            accessibilityLabel={t('explore.close')}
                            className="p-2 rounded-full"
                        >
                            <MaterialIcons name="close" size={22} color={ACCENT} />
                        </Pressable>
                    </HStack>
                    {/* Body — the existing browse-only sources drill-down. */}
                    <View className="flex-1" style={{ paddingBottom: insets.bottom }}>
                        <SourcesTabContent />
                    </View>
                </VStack>
            </Animated.View>
        </Modal>
    );
};

export default SourcesSheet;
