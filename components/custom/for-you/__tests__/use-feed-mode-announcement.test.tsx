/* eslint-disable @typescript-eslint/no-require-imports */
// Entering the capped or error state is announced to a screen reader. The
// announcement lives in the SCREEN, not in the Mera mark: the Dashboard has no
// mark, and the Feed's mark mounts only when needed, so a mark that mounts
// already capped would seed its own "previous mode" with the new state and
// stay silent about the very transition the reader needs to hear.

import { renderHook } from '@testing-library/react-native';
import { AccessibilityInfo } from 'react-native';

jest.mock('react-i18next', () => ({
    useTranslation: () => ({ t: (key: string) => key }),
}));

import type { FeedStatusMode } from '@/lib/feed-status-mode';
import { useFeedModeAnnouncement } from '../use-feed-mode-announcement';

let announce: jest.SpyInstance;
beforeEach(() => {
    announce = jest.spyOn(AccessibilityInfo, 'announceForAccessibility').mockImplementation(() => {});
});
afterEach(() => announce.mockRestore());

const run = (initial: FeedStatusMode) =>
    renderHook(({ mode }: { mode: FeedStatusMode }) => useFeedModeAnnouncement(mode), {
        initialProps: { mode: initial },
    });

describe('useFeedModeAnnouncement', () => {
    it('does not announce the state the screen mounted in', () => {
        run('limited');
        expect(announce).not.toHaveBeenCalled();
    });

    it('announces idle -> limited once, the transition a mark mounting already capped would miss', () => {
        const h = run('idle');
        h.rerender({ mode: 'limited' });
        h.rerender({ mode: 'limited' });
        expect(announce).toHaveBeenCalledTimes(1);
        expect(announce).toHaveBeenCalledWith('feedStatus.modeLimited');
    });

    it('announces entering error, and says nothing on the way back to idle or processing', () => {
        const h = run('processing');
        h.rerender({ mode: 'error' });
        h.rerender({ mode: 'idle' });
        h.rerender({ mode: 'processing' });
        expect(announce).toHaveBeenCalledTimes(1);
        expect(announce).toHaveBeenCalledWith('feedStatus.modeError');
    });
});
