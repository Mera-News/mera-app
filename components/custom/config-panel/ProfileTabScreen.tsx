import ScreenChatBubble from '@/components/custom/floating-chat/ScreenChatBubble';
import ProfileHubScreen from '@/components/custom/profile-hub/ProfileHubScreen';
import { Box } from '@/components/ui/box';
import { authClient } from '@/lib/auth-client';
import { TAB_BAR_HEIGHT } from '@/lib/navigation/tab-bar';
import type { ChatContext } from '@/lib/stores/floating-chat-store';
import React from 'react';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

const PERSONA_CONTEXT: ChatContext = { kind: 'persona' };

/**
 * Profile tab screen (Wave 12 hub restructure). The ~900-line
 * PersonaL1MeraProtocol megascroll is retired from the live tree; this tab now
 * renders the clean Profile hub (ProfileHubScreen) — blocked banner, daily-usage
 * widget, refresh-suggestions button, and hub rows pushing focused sub-screens
 * (Facts / Locations / Saved / Source preferences / Activity / Persona health).
 *
 * Gate on a signed-in userId, top safe-area padding, and the floating chat
 * bubble docked to this screen (unmounts with it on tab switch). The bubble gets
 * TAB_BAR_HEIGHT as extra bottom clearance since this screen sits inside the tab
 * shell.
 */
const ProfileTabScreen: React.FC = () => {
    const insets = useSafeAreaInsets();
    const { data: session } = authClient.useSession();
    const userId = session?.user?.id;

    if (!userId) return null;

    return (
        <Box className="flex-1 bg-black" style={{ paddingTop: insets.top }}>
            <ProfileHubScreen userId={userId} />
            <ScreenChatBubble context={PERSONA_CONTEXT} extraBottomOffset={TAB_BAR_HEIGHT} />
        </Box>
    );
};

export default ProfileTabScreen;
