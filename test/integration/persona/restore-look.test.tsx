// The launch look over an update reload's rebuild of the reader's spot: the iOS splash hold
// ignores routes while the rebuild runs, and Android's RestoreCover paints the same look. Real
// splash-hold and app-restart over the in-memory settings table; expo-router's usePathname is the
// integration setup's mock, driven per test. Mocked: expo-splash-screen, a native edge.
import { render, waitFor } from '@testing-library/react-native';
import { usePathname } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import React from 'react';
import { Platform } from 'react-native';

import RestoreCover from '@/components/custom/launch/RestoreCover';
import { __resetAppRestartForTests, RESTART_MARKER_KEY } from '@/lib/app-restart';
import { setSetting } from '@/lib/database/services/setting-service';
import {
    __resetSplashHoldForTests,
    beginRestoreLook,
    endRestoreLook,
    holdSplash,
    isRestoreBoot,
    SplashReleaser,
} from '@/lib/splash-hold';

jest.mock('expo-splash-screen', () => ({ preventAutoHideAsync: jest.fn(async () => {}), hide: jest.fn() }));

// The cover reads the marker through the settings table; a loaded machine needs the room.
jest.setTimeout(30_000);

const SPOT = { v: 1, tab: 'feed', page: null, tabStack: [], rootStack: [] };
const seedReload = () =>
    setSetting(RESTART_MARKER_KEY, JSON.stringify({ reason: 'ota', at: 1, backgroundedAt: null, lastForegroundAt: null, spot: SPOT }));
/** The cover is hidden from assistive tech (it is decoration), so queries must include hidden elements. */
const cover = (view: { queryByTestId: (id: string, o?: { includeHiddenElements?: boolean }) => unknown }) =>
    view.queryByTestId('restore-cover', { includeHiddenElements: true });
const pathIs = (p: string) => jest.mocked(usePathname).mockReturnValue(p);

describe('the restore look', () => {
    beforeEach(() => {
        __resetAppRestartForTests();
        __resetSplashHoldForTests();
        jest.mocked(SplashScreen.hide).mockClear();
        pathIs('/logged-in');
    });
    afterEach(() => jest.restoreAllMocks());

    it('a boot with a spot is a restore boot; a cold one is not', async () => {
        await expect(isRestoreBoot()).resolves.toBe(false);
        __resetAppRestartForTests();
        __resetSplashHoldForTests();
        await seedReload();
        await expect(isRestoreBoot()).resolves.toBe(true);
    });

    describe('iOS: the held splash', () => {
        beforeEach(() => jest.replaceProperty(Platform, 'OS', 'ios'));

        it('ignores route changes while the rebuild runs and hides when it ends', async () => {
            holdSplash();
            beginRestoreLook();
            const view = render(<SplashReleaser />);
            pathIs('/logged-in/app_container/feed');
            view.rerender(<SplashReleaser />);
            expect(SplashScreen.hide).not.toHaveBeenCalled();

            endRestoreLook();
            expect(SplashScreen.hide).toHaveBeenCalledTimes(1);
        });

        it('control: with no rebuild running the first real route hides it', () => {
            holdSplash();
            const view = render(<SplashReleaser />);
            pathIs('/logged-in/app_container/feed');
            view.rerender(<SplashReleaser />);
            expect(SplashScreen.hide).toHaveBeenCalledTimes(1);
        });
    });

    describe('Android: RestoreCover', () => {
        beforeEach(() => jest.replaceProperty(Platform, 'OS', 'android'));

        it('covers a restore boot until the rebuild is done', async () => {
            await seedReload();
            const view = render(<RestoreCover />);
            await waitFor(() => expect(cover(view)).not.toBeNull(), { timeout: 10_000 });

            beginRestoreLook();
            pathIs('/logged-in/app_container/feed');
            view.rerender(<RestoreCover />);
            expect(cover(view)).not.toBeNull();

            endRestoreLook();
            await waitFor(() => expect(cover(view)).toBeNull());
        });

        it('leaves when the gate routes somewhere without a rebuild (a sign-in)', async () => {
            await seedReload();
            const view = render(<RestoreCover />);
            await waitFor(() => expect(cover(view)).not.toBeNull(), { timeout: 10_000 });
            pathIs('/login');
            view.rerender(<RestoreCover />);
            expect(cover(view)).toBeNull();
        });

        it('never shows on a cold boot', async () => {
            const view = render(<RestoreCover />);
            await isRestoreBoot();
            await new Promise((r) => setTimeout(r, 20));
            expect(cover(view)).toBeNull();
        });
    });
});
