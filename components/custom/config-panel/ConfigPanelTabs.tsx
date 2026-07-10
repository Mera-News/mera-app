import { HStack } from '@/components/ui/hstack';
import { Pressable } from '@/components/ui/pressable';
import { Text } from '@/components/ui/text';
import { useConfigPanelActiveTab, useConfigPanelStore } from '@/lib/stores/config-panel-store';
import React from 'react';
import { useTranslation } from 'react-i18next';

type ConfigPanelTab = 'persona' | 'sources' | 'preferences';

const TabButton: React.FC<{
    readonly label: string;
    readonly isActive: boolean;
    readonly onPress: () => void;
}> = ({ label, isActive, onPress }) => (
    <Pressable
        onPress={onPress}
        className={`items-center px-4 py-2.5 rounded-full ${isActive ? 'bg-background-200' : 'bg-transparent'}`}
    >
        <Text
            size="sm"
            className={`font-medium ${isActive ? 'text-typography-950' : 'text-typography-400'}`}
        >
            {label}
        </Text>
    </Pressable>
);

const ConfigPanelTabs: React.FC = () => {
    const { t } = useTranslation();
    const activeTab = useConfigPanelActiveTab();
    const setActiveTab = useConfigPanelStore((s) => s.setActiveTab);

    const tabs: { key: ConfigPanelTab; label: string }[] = [
        { key: 'persona', label: t('configPanel.tabPersona') },
        { key: 'sources', label: t('configPanel.tabSources') },
        { key: 'preferences', label: t('configPanel.tabPreferences') },
    ];

    return (
        <HStack className="bg-background-50 rounded-full p-1">
            {tabs.map((tab) => (
                <TabButton
                    key={tab.key}
                    label={tab.label}
                    isActive={activeTab === tab.key}
                    onPress={() => setActiveTab(tab.key)}
                />
            ))}
        </HStack>
    );
};

export default ConfigPanelTabs;
