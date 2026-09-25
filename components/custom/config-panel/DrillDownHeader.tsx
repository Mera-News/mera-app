import { HStack } from '@/components/ui/hstack';
import { Pressable } from '@/components/ui/pressable';
import { Text } from '@/components/ui/text';
import { VStack } from '@/components/ui/vstack';
import { MaterialIcons } from '@expo/vector-icons';
import React from 'react';
import { useTranslation } from 'react-i18next';
import { StyleSheet, View } from 'react-native';

const BACK_GLYPH = 22;
/** p-1 at NativeWind's 14pt rem: the old box's padding and left pull. */
const BACK_PAD = 3.5;
const BACK_BOX = BACK_GLYPH + 2 * BACK_PAD;
const BACK_TARGET = 44;
const BACK_BLEED = (BACK_TARGET - BACK_BOX) / 2;
const BACK_FRAME = {
    width: BACK_TARGET,
    height: BACK_TARGET,
    marginVertical: -BACK_BLEED,
    marginLeft: -BACK_BLEED - BACK_PAD,
    marginRight: -BACK_BLEED,
    alignItems: 'center',
    justifyContent: 'center',
} as const;

interface DrillDownHeaderProps {
    readonly title: string;
    readonly titleContent?: React.ReactNode;
    readonly subtitle?: string;
    readonly titleNumberOfLines?: number;
    /** Optional: a screen that can be a root (e.g. mid-onboarding) omits it. */
    readonly onBack?: () => void;
    readonly rightAction?: React.ReactNode;
    /** Harness handle for the back button. */
    readonly backTestID?: string;
    /** Blocks leaving while something must not be interrupted (a language
     *  switch). Announced as disabled, not merely dimmed. */
    readonly backDisabled?: boolean;
}

/**
 * The ONE header for pushed pages: every config-panel drill-down and every
 * Settings sub-page. Settings used to have three header styles (an inline
 * arrow, a floating circle over a centred title, and a circle in a row); this
 * is the only one now.
 */
const DrillDownHeader: React.FC<DrillDownHeaderProps> = ({
    title,
    titleContent,
    subtitle,
    titleNumberOfLines = 1,
    onBack,
    rightAction,
    backTestID,
    backDisabled = false,
}) => {
    const { t } = useTranslation();
    return (
        <HStack className="px-4 py-3 items-center border-b border-gray-800">
            {/* A numeric 44pt frame pulled back by negative margins to the old
                29pt box (22pt glyph + 3.5pt padding, 3.5pt left of the row's
                padding), so nothing reflows and the arrow does not move. The
                arrow sits OUTSIDE the button: a glyph inside one surfaces on
                iOS as its own StaticText, and a hitSlop target measured as its
                visible box. The label says what the control DOES ("Back"),
                not the page title, which VoiceOver already reads below. */}
            {onBack && (
                <View
                    testID={backTestID ? `${backTestID}-frame` : undefined}
                    style={BACK_FRAME}
                >
                    <MaterialIcons
                        name="arrow-back"
                        size={BACK_GLYPH}
                        color="#FFFFFF"
                        style={backDisabled ? { opacity: 0.4 } : undefined}
                        accessible={false}
                        accessibilityElementsHidden
                        importantForAccessibility="no-hide-descendants"
                    />
                    <Pressable
                        testID={backTestID}
                        onPress={onBack}
                        disabled={backDisabled}
                        accessibilityRole="button"
                        accessibilityLabel={t('common.back')}
                        accessibilityState={{ disabled: backDisabled }}
                        style={StyleSheet.absoluteFill}
                    />
                </View>
            )}
            <VStack className={onBack ? 'ml-2 flex-1' : 'flex-1'}>
                {subtitle && (
                    <Text size="xs" className="text-gray-400" numberOfLines={1}>
                        {subtitle}
                    </Text>
                )}
                {titleContent ?? (
                    <Text
                        size="lg"
                        className="text-white font-semibold"
                        numberOfLines={titleNumberOfLines}
                        accessibilityRole="header"
                    >
                        {title}
                    </Text>
                )}
            </VStack>
            {rightAction}
        </HStack>
    );
};

export default DrillDownHeader;
