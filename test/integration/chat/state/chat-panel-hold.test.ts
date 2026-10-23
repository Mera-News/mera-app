// The chat panel's restart hold: while the panel is open no automatic reload (an OTA on a return) lands,
// and the reader's own Restart tap still reloads. Real app-restart, real floating-chat store, production
// build shape. Mocked: expo-updates only, an edge.
import { act, renderHook } from '@testing-library/react-native';
import { __resetAppRestartForTests, requestRestart } from '@/lib/app-restart';
import { useChatPanelHold } from '@/lib/chat-session/use-chat-session';
import database from '@/lib/database';
import { setCurrentPathname } from '@/lib/nav-state';
import { useFloatingChatStore } from '@/lib/stores/floating-chat-store';
import { setAppState } from '@/test/helpers';

const mockReloadAsync = jest.fn(async () => {});
jest.mock('expo-updates', () => ({
    isEnabled: true,
    reloadAsync: () => mockReloadAsync(),
}));

const store = () => useFloatingChatStore.getState();

/** One restart attempt. A blocked one leaves no cooldown behind; a reload latches the gate, so each test
 *  ends on its only successful one (resetting the gate would also drop the hold under test). */
async function reloadsOn(reason: 'ota' | 'update'): Promise<boolean> {
    mockReloadAsync.mockClear();
    await requestRestart(reason);
    return mockReloadAsync.mock.calls.length > 0;
}

describe('chat panel restart hold', () => {
    beforeEach(() => {
        __resetAppRestartForTests();
        (globalThis as { __DEV__?: boolean }).__DEV__ = false;
        setAppState('active');
        setCurrentPathname('/logged-in/app_container/feed');
        store().reset();
    });

    afterEach(async () => {
        (globalThis as { __DEV__?: boolean }).__DEV__ = true;
        setCurrentPathname('');
        await database.write(async () => {});
    });

    it('an automatic reload lands with the panel closed (positive control)', async () => {
        renderHook(() => useChatPanelHold());
        expect(await reloadsOn('ota')).toBe(true);
    });

    it('an open panel blocks the automatic reload, and closing it lifts the block', async () => {
        renderHook(() => useChatPanelHold());
        act(() => store().expand());
        expect(await reloadsOn('ota')).toBe(false);

        act(() => store().collapse());
        expect(await reloadsOn('ota')).toBe(true);
    });

    it('the reader\'s Restart tap still reloads under an open panel', async () => {
        renderHook(() => useChatPanelHold());
        act(() => store().expand());
        expect(await reloadsOn('update')).toBe(true);
    });

    it.each([
        ['toggle', () => store().toggle()],
        ['a store reset (logout, account switch)', () => store().reset()],
    ])('closing by %s releases the hold', async (_name, close) => {
        renderHook(() => useChatPanelHold());
        act(() => store().toggle());
        expect(await reloadsOn('ota')).toBe(false);
        act(close);
        expect(await reloadsOn('ota')).toBe(true);
    });

    it('unmounting the host while open releases the hold', async () => {
        const { unmount } = renderHook(() => useChatPanelHold());
        act(() => store().expand());
        expect(await reloadsOn('ota')).toBe(false);
        unmount();
        expect(await reloadsOn('ota')).toBe(true);
    });

    it('repeat opens take one hold, so one close releases it', async () => {
        renderHook(() => useChatPanelHold());
        act(() => store().expand());
        act(() => store().expand());
        expect(await reloadsOn('ota')).toBe(false);
        act(() => store().collapse());
        expect(await reloadsOn('ota')).toBe(true);
    });
});
