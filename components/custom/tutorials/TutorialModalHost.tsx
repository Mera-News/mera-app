import React from 'react';

import { BottomSheet } from '@/components/ui/bottom-sheet';
import { GluestackUIProvider } from '@/components/ui/gluestack-ui-provider';
import { PRE_AUTH_CHAPTER_ID } from '@/lib/tutorials/chapters';

import TutorialPlayer from './TutorialPlayer';

interface TutorialModalHostProps {
    readonly visible: boolean;
    readonly onClose: () => void;
    /** Defaults to the pre-auth chapter, `welcome`. */
    readonly chapterId?: string;
    /** The last slide's button (the first-launch tour: "Begin Mera"). */
    readonly finishLabel?: string;
    readonly onFinish?: () => void;
}

/**
 * The PRE-AUTH host: the tour rises over the language page as a full-height
 * sheet and drops back to it, and the page under it never moves (FinalJourney
 * #15). The kit BottomSheet, so it rises and leaves like every other sheet and
 * a drag down closes it too. `app/login.tsx` sits outside the logged-in stack,
 * so there is no route to push.
 *
 * The POST-auth host is a pushed route instead (`app/tutorials/player.tsx`):
 * `FloatingChatHost` is a sibling after the logged-in `<Stack>`, so a Modal
 * would paint above it and "Ask Mera" would open behind the tutorial. Nothing
 * here needs that: the player is mounted with `enableAskMera={false}` (no
 * session before login, so no agent to ask).
 *
 * The provider is inside the sheet because the sheet is its own native window.
 */
const TutorialModalHost: React.FC<TutorialModalHostProps> = ({ visible, onClose, chapterId, finishLabel, onFinish }) => (
    <BottomSheet open={visible} onClose={onClose} fullHeight testID="tutorial-sheet">
        <GluestackUIProvider>
            <TutorialPlayer
                chapterId={chapterId ?? PRE_AUTH_CHAPTER_ID}
                onClose={onClose}
                finishLabel={finishLabel}
                onFinish={onFinish}
                enableAskMera={false}
                inSheet
            />
        </GluestackUIProvider>
    </BottomSheet>
);

export default TutorialModalHost;
