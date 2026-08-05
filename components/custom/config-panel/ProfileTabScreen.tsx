import AbstractGradientBackdrop from '@/components/custom/AbstractGradientBackdrop';
import ProfileScreen from '@/components/custom/profile/ProfileScreen';
import { Box } from '@/components/ui/box';
import { authClient } from '@/lib/auth-client';
import { useUserStore } from '@/lib/stores/user-store';
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
    // LOCAL identity first, server session only as a fallback.
    //
    // This gate used to read `session?.user?.id` alone, so a server session the
    // app could not fetch — offline, a keychain-locked background wake, a 401
    // blip — rendered the ENTIRE tab as null. That also took out the only entry
    // point to the persona chat (MeraChatInvite lives inside ProfileScreen),
    // so a network wobble silently removed a feature from the app.
    //
    // Identity here is a local fact, exactly as lib/security/launch-route.ts
    // already treats it: only an explicit logout clears it. Offline state is
    // communicated by the existing banner, not by blanking the screen.
    const localUserId = useUserStore((s) => s.userId);
    const userId = localUserId ?? session?.user?.id;

    // Genuinely no identity on this device (pre-login). The launch gate routes
    // these users to /login; rendering nothing is only the interim frame.
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
