import ThemeSelector from '@/components/custom/ThemeSelector';
import { Box } from '@/components/ui/box';
import { GluestackUIProvider } from '@/components/ui/gluestack-ui-provider';
import { Pressable } from '@/components/ui/pressable';
import { Text } from '@/components/ui/text';
import { VStack } from '@/components/ui/vstack';
import { useThemeColors } from '@/lib/theme/tokens';
import { MaterialIcons } from '@expo/vector-icons';
import React from 'react';
import { ScrollView } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTranslation } from 'react-i18next';

interface AppearanceSettingsScreenProps {
    onBack?: () => void;
}

const AppearanceSettingsScreen: React.FC<AppearanceSettingsScreenProps> = ({ onBack }) => {
    const insets = useSafeAreaInsets();
    const { t } = useTranslation();
    const colors = useThemeColors();

    return (
        <GluestackUIProvider>
            <Box className="flex-1 bg-background-0">
                {/* Floating Back Button */}
                {onBack && (
                    <Box style={{ position: 'absolute', top: insets.top + 16, left: 16, zIndex: 20 }}>
                        <Pressable
                            onPress={onBack}
                            className="bg-background-100 rounded-full p-3 shadow-hard-2"
                        >
                            <MaterialIcons name="arrow-back" size={24} color={colors.icon} />
                        </Pressable>
                    </Box>
                )}

                {/* Header */}
                <VStack className="px-5 pb-5" style={{ paddingTop: insets.top + 16 }}>
                    <Text className="text-xl font-semibold text-typography-950 text-center">
                        {t('theme.title')}
                    </Text>
                </VStack>

                <ScrollView className="flex-1 pt-1">
                    <VStack className="px-5" space="xl">
                        <VStack space="md">
                            <VStack>
                                <Text className="text-typography-950 text-lg font-semibold">
                                    {t('theme.appTheme')}
                                </Text>
                                <Text className="text-typography-500 text-sm mt-0.5">
                                    {t('theme.appThemeDescription')}
                                </Text>
                            </VStack>

                            <ThemeSelector />
                        </VStack>
                    </VStack>
                </ScrollView>
            </Box>
        </GluestackUIProvider>
    );
};

export default AppearanceSettingsScreen;
