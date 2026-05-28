import ConfigScreen from '@/components/custom/config-panel/ConfigScreen';
import { GluestackUIProvider } from '@/components/ui/gluestack-ui-provider';
import React from 'react';

export default function ConfigPanelRoute() {
    return (
        <GluestackUIProvider mode="dark">
            <ConfigScreen />
        </GluestackUIProvider>
    );
}
