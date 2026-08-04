import LanguageSettingsScreen from '@/components/custom/config-mera/LanguageSettingsScreen';
import { Stack, useRouter } from 'expo-router';
import { useCallback, useState } from 'react';

export default function LanguagePage() {
    const router = useRouter();
    // A language switch presents Apple's system sheet and must not be left
    // half-done, so all three back affordances are locked together while it
    // runs: the in-screen arrow (handled inside the screen), the Android
    // hardware back (handled in useLanguageSwitch), and the iOS swipe-back
    // gesture — here. A disabled button with a live swipe is a half-measure.
    const [switching, setSwitching] = useState(false);
    const handleBusyChange = useCallback((busy: boolean) => setSwitching(busy), []);

    return (
        <>
            <Stack.Screen options={{ gestureEnabled: !switching }} />
            <LanguageSettingsScreen
                onBack={() => router.back()}
                onBusyChange={handleBusyChange}
            />
        </>
    );
}
