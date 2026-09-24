import AbstractGradientBackdrop from '@/components/custom/AbstractGradientBackdrop';
import { Box } from '@/components/ui/box';
import { Heading } from '@/components/ui/heading';
import { HStack } from '@/components/ui/hstack';
import { useTabBarClearance } from '@/lib/navigation/tab-bar';
import React from 'react';
import { useTranslation } from 'react-i18next';
import { ScrollView, useWindowDimensions } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import TabExplainerButton from '@/components/custom/for-you/TabExplainerButton';
import NotificationBellButton from '@/components/custom/notifications/NotificationBellButton';
import { headerTitleLineHeight } from '@/lib/typography/header-title-size';
import AppPreferencesTab from './AppPreferencesTab';

/**
 * Settings tab screen (Wave 5 tabs shell). Wraps the existing AppPreferencesTab
 * (formerly the config-panel's "Preferences" pill tab). The interim "Sources"
 * row that lived here has been removed (app-rethink wave) — Sources now lives
 * in Profile.
 *
 * Top-left screen heading mirrors the Profile tab idiom (ProfileScreen):
 * a fixed `<Heading size="4xl">` above the scroll area, reusing the same
 * `tabs.settings` string shown (hidden) on the tab trigger.
 *
 * Wrapped in a ScrollView (AppPreferencesTab itself has none) so the reduced
 * screen height under the tab bar still scrolls to the last item (logout /
 * policy links) instead of clipping.
 */
const SettingsTabScreen: React.FC = () => {
    const insets = useSafeAreaInsets();
    // NativeTabs' own SafeAreaProvider already counts the bar on iOS; adding
    // TAB_BAR_HEIGHT again left ~49pt of dead space under Log out.
    const tabBarClearance = useTabBarClearance();
    const { t } = useTranslation();
    const { width: windowWidth } = useWindowDimensions();

    return (
        // Unpadded wrapper. The backdrop hangs off THIS box, not the padded one
        // below, so it spans the FULL screen including the safe areas — an
        // absolute fill resolves against its parent's CONTENT box, so mounting it
        // inside the padded box left a black strip in the inset.
        <Box className="flex-1">
            {/* App-wide tab background. Must be the FIRST child so it paints
                behind everything else on the page. */}
            <AbstractGradientBackdrop />

            {/* No opaque fill: the backdrop above is the page background. */}
            <Box className="flex-1" style={{ paddingTop: insets.top }}>

            <HStack className="items-center justify-between px-5 pt-4 mb-2">
                {/* "Settings (?)", the "?" right after the title as on every
                    other tab (owner). One line: a shrinking title must truncate,
                    never wrap mid-word. */}
                <HStack className="items-center flex-1 min-w-0 mr-3" space="sm">
                    <Heading
                        size="4xl"
                        className="text-white flex-shrink min-w-0"
                        numberOfLines={1}
                        testID="settings-title"
                    >
                        {t('tabs.settings')}
                    </Heading>
                    <TabExplainerButton tab="settings" testID="settings-explainer-open" />
                </HStack>
                {/* The bell at the far right (owner), the same component as every
                    other tab, pinned to the title's line height so it centres on
                    the title and the row keeps its height. */}
                <HStack
                    className="items-center"
                    style={{ height: headerTitleLineHeight(windowWidth) }}
                    testID="settings-header-actions"
                >
                    <NotificationBellButton />
                </HStack>
            </HStack>

            <ScrollView
                className="flex-1"
                contentContainerStyle={{ flexGrow: 1, paddingBottom: tabBarClearance + 24 }}
                showsVerticalScrollIndicator={false}
            >
                <AppPreferencesTab />
            </ScrollView>
        </Box>
        </Box>
    );
};

export default SettingsTabScreen;
