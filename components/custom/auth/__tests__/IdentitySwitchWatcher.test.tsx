/* eslint-disable @typescript-eslint/no-require-imports */
// The catch-all watcher.
//
// Its whole value is in what it does NOT do. An unresolved session is the
// offline path and the common case, and a watcher that fired on it would eject
// or wipe users who are simply on a plane. Most of this file pins negatives.

import { render, waitFor } from '@testing-library/react-native';
import React from 'react';

const mockReplace = jest.fn();
jest.mock('expo-router', () => ({ router: { replace: (...a: any[]) => mockReplace(...a) } }));

let mockSession: any = null;
jest.mock('@/lib/auth-client', () => ({ authClient: { useSession: () => ({ data: mockSession }) } }));

const mockGetSetting = jest.fn(async (_k: string): Promise<string | null> => null);
jest.mock('@/lib/database/services/setting-service', () => ({
    getSetting: (k: string) => mockGetSetting(k),
}));

let mockBlocked = false;
jest.mock('@/lib/security/identity-gate', () => ({
    isIdentitySwitchBlocked: () => mockBlocked,
}));

jest.mock('@/lib/logger', () => ({
    __esModule: true,
    default: { captureMessage: jest.fn(), captureException: jest.fn() },
}));

import IdentitySwitchWatcher, {
    __resetIdentitySwitchWatcherForTests,
} from '../IdentitySwitchWatcher';

beforeEach(() => {
    jest.clearAllMocks();
    __resetIdentitySwitchWatcherForTests();
    mockSession = null;
    mockBlocked = false;
    mockGetSetting.mockResolvedValue(null);
});

/** Let the effect's async body settle. */
async function settle() {
    await waitFor(() => expect(true).toBe(true));
    await Promise.resolve();
    await Promise.resolve();
}

describe('IdentitySwitchWatcher', () => {
    it('hands a genuine mismatch back to the cold-start gate', async () => {
        mockSession = { user: { id: 'B' } };
        mockGetSetting.mockResolvedValue('A');

        render(<IdentitySwitchWatcher />);

        await waitFor(() => expect(mockReplace).toHaveBeenCalledWith('/logged-in'));
        const logger = require('@/lib/logger').default;
        expect(logger.captureMessage).toHaveBeenCalled();
    });

    it('reads the owner off DISK, not off the store', async () => {
        // On a failed stamp the store and the disk disagree, and the disk is
        // what every gate keys off. Catching that is the point.
        mockSession = { user: { id: 'B' } };
        mockGetSetting.mockResolvedValue('A');

        render(<IdentitySwitchWatcher />);

        await waitFor(() => expect(mockGetSetting).toHaveBeenCalledWith('cached_user_id'));
    });

    it('does nothing when the ids agree', async () => {
        mockSession = { user: { id: 'A' } };
        mockGetSetting.mockResolvedValue('A');

        render(<IdentitySwitchWatcher />);
        await settle();

        expect(mockReplace).not.toHaveBeenCalled();
    });

    // ── THE OFFLINE CONTRACT ─────────────────────────────────────────────
    it('IGNORES an unresolved session — that is the offline path', async () => {
        mockSession = null;
        mockGetSetting.mockResolvedValue('A');

        render(<IdentitySwitchWatcher />);
        await settle();

        expect(mockReplace).not.toHaveBeenCalled();
        // Not even a settings read: the happy path pays nothing.
        expect(mockGetSetting).not.toHaveBeenCalled();
    });

    it('ignores a session object with no user id', async () => {
        mockSession = { user: {} };

        render(<IdentitySwitchWatcher />);
        await settle();

        expect(mockGetSetting).not.toHaveBeenCalled();
        expect(mockReplace).not.toHaveBeenCalled();
    });

    it('an ABSENT stamped owner is not a mismatch', async () => {
        // Nothing stamped yet is the fresh-login state the cold-start gate
        // already handles. Firing here would fight it.
        mockSession = { user: { id: 'B' } };
        mockGetSetting.mockResolvedValue(null);

        render(<IdentitySwitchWatcher />);
        await settle();

        expect(mockReplace).not.toHaveBeenCalled();
    });

    it('stays quiet when the settings read throws', async () => {
        mockSession = { user: { id: 'B' } };
        mockGetSetting.mockRejectedValue(new Error('db unreadable'));

        render(<IdentitySwitchWatcher />);
        await settle();

        expect(mockReplace).not.toHaveBeenCalled();
    });

    it('stands down while the blocking screen is mounted', async () => {
        // The ids disagree there BY CONSTRUCTION — that is why the screen is up.
        mockBlocked = true;
        mockSession = { user: { id: 'B' } };
        mockGetSetting.mockResolvedValue('A');

        render(<IdentitySwitchWatcher />);
        await settle();

        expect(mockReplace).not.toHaveBeenCalled();
        expect(mockGetSetting).not.toHaveBeenCalled();
    });

    it('fires at most once per process, however many times it remounts', async () => {
        mockSession = { user: { id: 'B' } };
        mockGetSetting.mockResolvedValue('A');

        const first = render(<IdentitySwitchWatcher />);
        await waitFor(() => expect(mockReplace).toHaveBeenCalledTimes(1));
        first.unmount();

        render(<IdentitySwitchWatcher />);
        await settle();

        expect(mockReplace).toHaveBeenCalledTimes(1);
    });
});

export {};
