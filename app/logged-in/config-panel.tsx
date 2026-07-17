import { Redirect } from 'expo-router';
import React from 'react';

// Wave 5: Profile is now a bottom tab (app_container/profile.tsx) — this route
// is kept only so deep links and any stale references to /logged-in/config-panel
// keep working. ConfigScreen/ConfigPanelTabs are left in place (unwired, not
// deleted) for a later cleanup wave.
export default function ConfigPanelRoute() {
    return <Redirect href="/logged-in/app_container/profile" />;
}
