import { Box } from '@/components/ui/box';
import { HStack } from '@/components/ui/hstack';
import { Pressable } from '@/components/ui/pressable';
import { Text } from '@/components/ui/text';
import { MaterialIcons } from '@expo/vector-icons';
import { router } from 'expo-router';
import React from 'react';
import { useTranslation } from 'react-i18next';
import { ScrollView } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import AppPreferencesTab from './AppPreferencesTab';

/**
 * Settings tab screen (Wave 5 tabs shell). Wraps the existing AppPreferencesTab
 * (formerly the config-panel's "Preferences" pill tab) with a "Sources" row at
 * the top — an interim access point so Sources management stays reachable now
 * that config-panel's pill tabs are unwired. Sources moves into the Explore tab
 * in a later wave; until then it pushes app/logged-in/sources.tsx.
 *
 * Wrapped in a ScrollView (AppPreferencesTab itself has none) so the extra row
 * plus the reduced screen height under the tab bar still scrolls to the last
 * item (logout / policy links) instead of clipping.
 */
const SettingsTabScreen: React.FC = () => {
    const { t } = useTranslation();
    const insets = useSafeAreaInsets();

    return (
        <ScrollView
            className="flex-1 bg-black"
            style={{ paddingTop: insets.top }}
            contentContainerStyle={{ flexGrow: 1 }}
            showsVerticalScrollIndicator={false}
        >
            <Box className="px-5 pt-2">
                <Pressable
                    onPress={() => router.push('/logged-in/sources')}
                    className="flex-row items-center justify-between py-3 px-4 mb-3 border border-gray-700 rounded-lg"
                    accessibilityRole="button"
                    accessibilityLabel={t('settings.sources')}
                >
                    <HStack className="items-center" space="md">
                        <MaterialIcons name="tune" size={20} color="#EDA77E" />
                        <Text className="text-base text-white">{t('settings.sources')}</Text>
                    </HStack>
                    <MaterialIcons name="chevron-right" size={20} color="#999999" />
                </Pressable>
            </Box>
            <AppPreferencesTab />
        </ScrollView>
    );
};

export default SettingsTabScreen;
