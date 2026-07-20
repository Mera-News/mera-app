import ScreenChatBubble from '@/components/custom/floating-chat/ScreenChatBubble';
import ProfileScreen from '@/components/custom/profile/ProfileScreen';
import { Box } from '@/components/ui/box';
import { authClient } from '@/lib/auth-client';
import { TAB_BAR_HEIGHT } from '@/lib/navigation/tab-bar';
import type { ChatContext } from '@/lib/stores/floating-chat-store';
import React from 'react';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

const PERSONA_CONTEXT: ChatContext = { kind: 'persona' };

/**
 * Profile tab screen (mirror-first redesign). Renders the approachable,
 * non-technical ProfileScreen — the Mera "mirror" CTA, plain-language "About
 * you" strings, and a single "Advanced" row that pushes the full power-user hub
 * (AdvancedHubScreen). The former hub content lives behind that Advanced row.
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
            <ProfileScreen userId={userId} />
            <ScreenChatBubble context={PERSONA_CONTEXT} extraBottomOffset={TAB_BAR_HEIGHT} />
        </Box>
    );
};

export default ProfileTabScreen;
