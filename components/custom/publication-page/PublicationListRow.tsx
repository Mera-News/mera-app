import TapPressable from '@/components/custom/cards/TapPressable';
import { HStack } from '@/components/ui/hstack';
import { Text } from '@/components/ui/text';
import { VStack } from '@/components/ui/vstack';
import type { SourcePrefUiLevel } from '@/lib/database/services/publication-pref-ui-actions';
import { useDisplayPublication } from '@/lib/stores/publication-display-store';
import { MaterialIcons } from '@expo/vector-icons';
import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { I18nManager, StyleSheet, View } from 'react-native';

const MORE_COLOR = '#10b981';
const FEWER_COLOR = '#f59e0b';
const CHEVRON_COLOR = '#999999';
const PRESSED_OPACITY = 0.6;
export const PRESS_DELAY_MS = 130;

interface PublicationListRowProps {
    /** The RAW publication name; the row shows its display form. */
    readonly rawName: string;
    /** Second line: the website host, optionally prefixed (L1 adds the country). */
    readonly subtitle?: string | null;
    /** A leading flag emoji (L1 search hits span countries). */
    readonly flag?: string | null;
    /** The current more/fewer state, shown as a small glyph. Read locally. */
    readonly prefLevel: SourcePrefUiLevel;
    readonly onPress: () => void;
    readonly testID: string;
}

/**
 * One publication in a Sources list: name, host, the more/fewer state as a
 * glyph, a chevron. Tapping opens the publication page, where more/fewer,
 * Top headlines and Subscribe now live. There are no feeds here, by design.
 *
 * The visual is hidden from accessibility and a CHILDLESS labelled button is
 * laid over it: icon-font glyphs inside a labelled pressable still surface on
 * iOS as their own StaticText. The pressed state is React state on a static
 * style, since a function style is dropped on device.
 */
const PublicationListRow: React.FC<PublicationListRowProps> = ({
    rawName,
    subtitle,
    flag,
    prefLevel,
    onPress,
    testID,
}) => {
    const { t } = useTranslation();
    const shown = useDisplayPublication(rawName.trim()) || rawName;
    const [pressed, setPressed] = useState(false);

    const prefLabel =
        prefLevel === 'prioritised'
            ? t('publicationPage.prefMoreA11y')
            : prefLevel === 'deprioritised'
              ? t('publicationPage.prefFewerA11y')
              : null;
    const label = [shown, subtitle, prefLabel].filter(Boolean).join(', ');

    return (
        <View className="mx-4 mb-3 rounded-lg border border-gray-700" testID={`${testID}-frame`}>
            <HStack
                space="md"
                className="items-center px-4 py-3"
                style={pressed ? { opacity: PRESSED_OPACITY } : undefined}
                accessible={false}
                accessibilityElementsHidden
                importantForAccessibility="no-hide-descendants"
            >
                {flag ? <Text className="text-2xl">{flag}</Text> : null}
                <VStack className="flex-1" space="xs">
                    <Text className="text-base text-white" numberOfLines={2}>
                        {shown}
                    </Text>
                    {subtitle ? (
                        <Text size="xs" className="text-gray-500" numberOfLines={1}>
                            {subtitle}
                        </Text>
                    ) : null}
                </VStack>
                {prefLevel !== 'none' ? (
                    <MaterialIcons
                        testID={`${testID}-pref-${prefLevel}`}
                        name={prefLevel === 'prioritised' ? 'arrow-upward' : 'arrow-downward'}
                        size={16}
                        color={prefLevel === 'prioritised' ? MORE_COLOR : FEWER_COLOR}
                    />
                ) : null}
                <MaterialIcons
                    name={I18nManager.isRTL ? 'chevron-left' : 'chevron-right'}
                    size={20}
                    color={CHEVRON_COLOR}
                />
            </HStack>
            <TapPressable
                testID={testID}
                onPress={onPress}
                // Delayed, so a finger that starts a scroll on the row does
                // not flash the pressed state.
                unstable_pressDelay={PRESS_DELAY_MS}
                onPressIn={() => setPressed(true)}
                onPressOut={() => setPressed(false)}
                accessibilityRole="button"
                accessibilityLabel={label}
                style={StyleSheet.absoluteFill}
            />
        </View>
    );
};

export default PublicationListRow;
