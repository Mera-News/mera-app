import { Box } from '@/components/ui/box';
import { Pressable } from '@/components/ui/pressable';
import { Text } from '@/components/ui/text';
import { VStack } from '@/components/ui/vstack';
import { ProcessingMode } from '@/lib/generated/graphql-types';
import { MaterialIcons } from '@expo/vector-icons';
import React from 'react';
import { useTranslation } from 'react-i18next';

const ACCENT = 'rgb(231, 138, 83)';

interface ProcessingModePillProps {
    readonly mode: ProcessingMode;
    readonly selected: boolean;
    readonly disabled: boolean;
    readonly onPress: () => void;
}

/**
 * One option of the Mera Protocol processing-mode selector. On-device carries
 * a small "Beta" pill on its icon (owner call); Cloud never does. The pill is
 * part of the option's accessibility label ("On-device, beta"), not a second
 * stop for VoiceOver.
 */
const ProcessingModePill: React.FC<ProcessingModePillProps> = ({ mode, selected, disabled, onPress }) => {
    const { t } = useTranslation();
    const onDevice = mode === ProcessingMode.OnDevice;
    const title = t(onDevice ? 'meraProtocol.onDeviceMode' : 'meraProtocol.cloudMode');
    const subtitle = t(onDevice ? 'meraProtocol.onDeviceModeSubtitle' : 'meraProtocol.cloudModeSubtitle');
    const iconColor = selected ? '#34d399' : '#9ca3af';

    return (
        <Pressable
            testID={`processing-mode-${onDevice ? 'on-device' : 'cloud'}`}
            onPress={onPress}
            disabled={disabled}
            accessibilityRole="radio"
            accessibilityState={{ selected, checked: selected, disabled }}
            accessibilityLabel={onDevice ? `${title}, ${t('common.beta')}` : title}
            className={
                'flex-1 rounded-lg px-4 py-3 border ' +
                (selected ? 'border-emerald-500 bg-emerald-950' : 'border-gray-700 bg-background-50')
            }
        >
            <VStack space="xs" className="items-center">
                <Box style={{ position: 'relative' }}>
                    <MaterialIcons name={onDevice ? 'smartphone' : 'cloud'} size={22} color={iconColor} />
                    {onDevice && (
                        <Box
                            testID="processing-mode-beta"
                            importantForAccessibility="no-hide-descendants"
                            accessibilityElementsHidden
                            style={{
                                position: 'absolute',
                                top: -8,
                                left: 14,
                                borderWidth: 1,
                                borderColor: ACCENT,
                                borderRadius: 999,
                                paddingHorizontal: 5,
                                paddingVertical: 0,
                                backgroundColor: 'rgba(0,0,0,0.6)',
                            }}
                        >
                            <Text size="2xs" style={{ color: ACCENT, fontWeight: '600' }}>
                                {t('common.beta')}
                            </Text>
                        </Box>
                    )}
                </Box>
                <Text className={'text-center font-medium ' + (selected ? 'text-emerald-400' : 'text-white')}>
                    {title}
                </Text>
                <Text size="xs" className="text-center text-typography-400">
                    {subtitle}
                </Text>
            </VStack>
        </Pressable>
    );
};

export default ProcessingModePill;
