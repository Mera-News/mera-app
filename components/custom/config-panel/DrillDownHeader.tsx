import { HStack } from '@/components/ui/hstack';
import { Pressable } from '@/components/ui/pressable';
import { Text } from '@/components/ui/text';
import { VStack } from '@/components/ui/vstack';
import { MaterialIcons } from '@expo/vector-icons';
import React from 'react';
import { useTranslation } from 'react-i18next';

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
            {/* hitSlop 12 brings a ~30pt glyph target to ~54pt, over Apple's
                44pt minimum. The label says what the control DOES ("Back"),
                not the page title, which VoiceOver already reads below. */}
            {onBack && (
                <Pressable
                    testID={backTestID}
                    onPress={onBack}
                    disabled={backDisabled}
                    hitSlop={12}
                    accessibilityRole="button"
                    accessibilityLabel={t('common.back')}
                    accessibilityState={{ disabled: backDisabled }}
                    className={`p-1 -ml-1 rounded-full ${backDisabled ? 'opacity-40' : ''}`}
                >
                    <MaterialIcons name="arrow-back" size={22} color="#FFFFFF" />
                </Pressable>
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
