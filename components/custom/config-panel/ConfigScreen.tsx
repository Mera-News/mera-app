import { Box } from '@/components/ui/box';
import { HStack } from '@/components/ui/hstack';
import { Pressable } from '@/components/ui/pressable';
import AppPreferencesTab from '@/components/custom/config-mera/AppPreferencesTab';
import { authClient } from '@/lib/auth-client';
import { useConfigPanelActiveTab } from '@/lib/stores/config-panel-store';
import { MaterialIcons } from '@expo/vector-icons';
import { router } from 'expo-router';
import React from 'react';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import ConfigPanelTabs from './ConfigPanelTabs';
import PersonaTabContent from './PersonaTabContent';
import SourcesTabContent from './SourcesTabContent';

const ConfigScreen: React.FC = () => {
    const insets = useSafeAreaInsets();
    const activeTab = useConfigPanelActiveTab();
    const { data: session } = authClient.useSession();
    const userId = session?.user?.id;

    const renderTabContent = () => {
        if (!userId) return null;

        switch (activeTab) {
            case 'persona':
                return <PersonaTabContent key="persona" userId={userId} />;
            case 'sources':
                return <SourcesTabContent key="sources" />;
            case 'preferences':
                return (
                    <Box className="flex-1" key="preferences">
                        <AppPreferencesTab />
                    </Box>
                );
        }
    };

    return (
        <Box className="flex-1 bg-black" style={{ paddingTop: insets.top }}>
            {/* Header: Back button + Tab Selector */}
            <HStack className="items-center px-4 pt-2 pb-2">
                <Pressable
                    onPress={() => router.back()}
                    className="p-3 rounded-full bg-gray-800"
                >
                    <MaterialIcons name="arrow-back" size={20} color="#FFFFFF" />
                </Pressable>
                <Box className="flex-1 items-center">
                    <ConfigPanelTabs />
                </Box>
            </HStack>

            {/* Tab Content */}
            {renderTabContent()}
        </Box>
    );
};

export default ConfigScreen;
