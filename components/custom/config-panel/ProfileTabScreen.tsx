import { Box } from '@/components/ui/box';
import ScreenChatBubble from '@/components/custom/floating-chat/ScreenChatBubble';
import { authClient } from '@/lib/auth-client';
import { TAB_BAR_HEIGHT } from '@/lib/navigation/tab-bar';
import type { ChatContext } from '@/lib/stores/floating-chat-store';
import React from 'react';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import PersonaTabContent from './PersonaTabContent';

const PERSONA_CONTEXT: ChatContext = { kind: 'persona' };

/**
 * Profile tab screen (Wave 5 tabs shell). Renders the same PersonaTabContent
 * that used to live behind the config-panel's "Persona" pill tab
 * (components/custom/config-panel/ConfigScreen.tsx), now mounted directly as
 * a bottom tab. Reproduces ConfigScreen's persona-tab composition: gate on a
 * signed-in userId, top safe-area padding (ConfigScreen applied this on its
 * outer header wrapper; PersonaL1MeraProtocol has no top-inset handling of
 * its own), and the floating chat bubble docked to this screen (unmounts
 * with it on tab switch, same as ScreenChatBubble everywhere else).
 *
 * The bubble gets TAB_BAR_HEIGHT as extra bottom clearance since — unlike
 * ConfigScreen, which was a full-screen pushed route with no bottom bar —
 * this screen sits inside the tab shell.
 */
const ProfileTabScreen: React.FC = () => {
    const insets = useSafeAreaInsets();
    const { data: session } = authClient.useSession();
    const userId = session?.user?.id;

    if (!userId) return null;

    return (
        <Box className="flex-1 bg-black" style={{ paddingTop: insets.top }}>
            <PersonaTabContent userId={userId} />
            <ScreenChatBubble context={PERSONA_CONTEXT} extraBottomOffset={TAB_BAR_HEIGHT} />
        </Box>
    );
};

export default ProfileTabScreen;
