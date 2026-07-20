import React from 'react';
import { ScrollView } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import AppPreferencesTab from './AppPreferencesTab';

/**
 * Settings tab screen (Wave 5 tabs shell). Wraps the existing AppPreferencesTab
 * (formerly the config-panel's "Preferences" pill tab). The interim "Sources"
 * row that lived here has been removed (app-rethink wave) — Sources now lives
 * in Profile.
 *
 * Wrapped in a ScrollView (AppPreferencesTab itself has none) so the reduced
 * screen height under the tab bar still scrolls to the last item (logout /
 * policy links) instead of clipping.
 */
const SettingsTabScreen: React.FC = () => {
    const insets = useSafeAreaInsets();

    return (
        <ScrollView
            className="flex-1 bg-black"
            style={{ paddingTop: insets.top }}
            contentContainerStyle={{ flexGrow: 1 }}
            showsVerticalScrollIndicator={false}
        >
            <AppPreferencesTab />
        </ScrollView>
    );
};

export default SettingsTabScreen;
