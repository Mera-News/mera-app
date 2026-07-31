import AbstractGradientBackdrop from '@/components/custom/AbstractGradientBackdrop';
import ProfileScreen from '@/components/custom/profile/ProfileScreen';
import { Box } from '@/components/ui/box';
import { authClient } from '@/lib/auth-client';
import React from 'react';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

/**
 * Profile tab screen (mirror-first redesign). Renders the approachable,
 * non-technical ProfileScreen — the Mera "mirror" CTA, plain-language "About
 * you" strings, and a single "Advanced" row that pushes the full power-user hub
 * (AdvancedHubScreen). The former hub content lives behind that Advanced row.
 *
 * Gate on a signed-in userId + top safe-area padding. The Mera chat entry point
 * is now the static MeraChatInvite row inside ProfileScreen (it replaced the
 * former floating ScreenChatBubble docked here).
 */
const ProfileTabScreen: React.FC = () => {
    const insets = useSafeAreaInsets();
    const { data: session } = authClient.useSession();
    const userId = session?.user?.id;

    if (!userId) return null;

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

            <ProfileScreen userId={userId} />
        </Box>
        </Box>
    );
};

export default ProfileTabScreen;
