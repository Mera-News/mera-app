import ErrorBoundary from '@/components/custom/ErrorBoundary';
import { FullScreenErrorFallback } from '@/components/custom/ErrorFallback';
import ProfileTabScreen from '@/components/custom/config-panel/ProfileTabScreen';
import React from 'react';

export default function ProfileTab() {
    return (
        <ErrorBoundary level="screen" FallbackComponent={FullScreenErrorFallback}>
            <ProfileTabScreen />
        </ErrorBoundary>
    );
}
