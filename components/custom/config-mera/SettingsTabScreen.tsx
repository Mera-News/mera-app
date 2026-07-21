import { Box } from '@/components/ui/box';
import { Heading } from '@/components/ui/heading';
import { HStack } from '@/components/ui/hstack';
import React from 'react';
import { useTranslation } from 'react-i18next';
import { ScrollView } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import AppPreferencesTab from './AppPreferencesTab';

/**
 * Settings tab screen (Wave 5 tabs shell). Wraps the existing AppPreferencesTab
 * (formerly the config-panel's "Preferences" pill tab). The interim "Sources"
 * row that lived here has been removed (app-rethink wave) — Sources now lives
 * in Profile.
 *
 * Top-left screen heading mirrors the Profile tab idiom (ProfileScreen):
 * a fixed `<Heading size="3xl">` above the scroll area, reusing the same
 * `tabs.settings` string shown (hidden) on the tab trigger.
 *
 * Wrapped in a ScrollView (AppPreferencesTab itself has none) so the reduced
 * screen height under the tab bar still scrolls to the last item (logout /
 * policy links) instead of clipping.
 */
const SettingsTabScreen: React.FC = () => {
    const insets = useSafeAreaInsets();
    const { t } = useTranslation();

    return (
        <Box className="flex-1 bg-black" style={{ paddingTop: insets.top }}>
            <HStack className="items-start justify-between px-5 pt-4 mb-2">
                <Heading size="3xl" className="text-white" numberOfLines={1}>
                    {t('tabs.settings')}
                </Heading>
            </HStack>

            <ScrollView
                className="flex-1"
                contentContainerStyle={{ flexGrow: 1 }}
                showsVerticalScrollIndicator={false}
            >
                <AppPreferencesTab />
            </ScrollView>
        </Box>
    );
};

export default SettingsTabScreen;
