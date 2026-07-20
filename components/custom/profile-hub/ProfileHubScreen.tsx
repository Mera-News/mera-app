// DEPRECATED (mirror-first Profile redesign).
//
// The former Profile-tab hub. Its content moved verbatim to
// `components/custom/profile/AdvancedHubScreen.tsx`, which is now pushed from
// the single "Advanced" row on the new mirror-first `ProfileScreen`. The Profile
// tab renders `ProfileScreen` (via ProfileTabScreen), so nothing imports this
// file anymore. Kept as a thin, self-documenting compatibility shim — delete
// once no external branch references it.

import AdvancedHubScreen from '@/components/custom/profile/AdvancedHubScreen';
import React from 'react';

interface ProfileHubScreenProps {
    readonly userId: string;
}

/** @deprecated Use ProfileScreen (Profile tab) / AdvancedHubScreen (pushed). */
const ProfileHubScreen: React.FC<ProfileHubScreenProps> = ({ userId }) => (
    <AdvancedHubScreen userId={userId} onBack={() => { /* no push context */ }} />
);

export default ProfileHubScreen;
