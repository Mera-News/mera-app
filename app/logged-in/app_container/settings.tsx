import ErrorBoundary from '@/components/custom/ErrorBoundary';
import { FullScreenErrorFallback } from '@/components/custom/ErrorFallback';
import SettingsTabScreen from '@/components/custom/config-mera/SettingsTabScreen';
import React from 'react';

export default function SettingsTab() {
    return (
        <ErrorBoundary level="screen" FallbackComponent={FullScreenErrorFallback}>
            <SettingsTabScreen />
        </ErrorBoundary>
    );
}
