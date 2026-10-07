const mockPush = jest.fn();
const mockNavigate = jest.fn();
jest.mock('expo-router', () => ({
    router: { push: (...a: unknown[]) => mockPush(...a), navigate: (...a: unknown[]) => mockNavigate(...a) },
    useFocusEffect: jest.fn(),
}));
const mockNavigateToPage = jest.fn();
jest.mock('@/components/custom/nav/navigate-to-page', () => ({
    navigateToPage: (...a: unknown[]) => mockNavigateToPage(...a),
}));
const mockBackListeners: (() => boolean)[] = [];
jest.mock('react-native', () => ({
    BackHandler: {
        addEventListener: (_e: string, fn: () => boolean) => {
            mockBackListeners.push(fn);
            return { remove: () => mockBackListeners.splice(mockBackListeners.indexOf(fn), 1) };
        },
    },
}));

import { reportSurface, resetCurrentSurface } from '@/components/custom/nav/current-surface';
import {
    armPendingFocus,
    FEED_SHAPERS,
    FOCUS_EXPIRY_MS,
    FOCUS_UNARMED_MAX_AGE_MS,
    navigateToSetting,
    resetPendingFocus,
    returnToJumpOrigin,
    routeForFocus,
    takeFocus,
    useFocusTargetStore,
} from '../focus-target';

beforeEach(() => {
    resetPendingFocus();
    resetCurrentSurface();
    mockPush.mockClear();
    mockNavigate.mockClear();
    mockNavigateToPage.mockClear();
});

describe('routing', () => {
    it('opens the Profile page for its cards, pushing nothing', () => {
        navigateToSetting(FEED_SHAPERS);
        expect(mockNavigateToPage).toHaveBeenCalledWith('profile');
        expect(mockPush).not.toHaveBeenCalled();
        expect(routeForFocus('profile.places').surface).toBe('profile');
    });

    it('does nothing for an empty list', () => {
        navigateToSetting([]);
        expect(mockNavigateToPage).not.toHaveBeenCalled();
    });
});

describe('one-shot pending target', () => {
    it('scrolls to the first id, highlights the rest, and fires once each', () => {
        navigateToSetting(FEED_SHAPERS, 0);
        armPendingFocus(10);
        expect(takeFocus('profile.places', 20)).toBe('highlight');
        expect(takeFocus('profile.facts', 20)).toBe('scroll');
        expect(takeFocus('profile.facts', 20)).toBe('none');
        expect(takeFocus('profile.sources', 20)).toBe('highlight');
        expect(takeFocus('profile.topicsDeclined', 20)).toBe('highlight');
        expect(useFocusTargetStore.getState().pending).toBeNull();
    });

    it('expires FOCUS_EXPIRY_MS after the destination gains focus, not after the tap', () => {
        navigateToSetting('profile.facts', 0);
        // A slow tab switch: arming happens well after the tap.
        armPendingFocus(20_000);
        expect(takeFocus('profile.facts', 20_000 + FOCUS_EXPIRY_MS - 1)).toBe('scroll');

        navigateToSetting('profile.facts', 0);
        armPendingFocus(100);
        expect(takeFocus('profile.facts', 100 + FOCUS_EXPIRY_MS + 1)).toBe('none');
        expect(useFocusTargetStore.getState().pending).toBeNull();
    });

    it('drops a jump whose destination never gained focus', () => {
        navigateToSetting('profile.facts', 0);
        expect(takeFocus('profile.facts', FOCUS_UNARMED_MAX_AGE_MS + 1)).toBe('none');
    });

    it('arming twice keeps the first time', () => {
        navigateToSetting('profile.facts', 0);
        armPendingFocus(100);
        armPendingFocus(4_000);
        expect(useFocusTargetStore.getState().pending?.armedAt).toBe(100);
    });

    it('reset clears the target and the jump', () => {
        reportSurface('feed');
        navigateToSetting('profile.facts');
        resetPendingFocus();
        expect(useFocusTargetStore.getState()).toEqual({ pending: null, jump: null });
        expect(mockBackListeners).toHaveLength(0);
    });
});

describe('jump-origin Back', () => {
    it('returns to the page the jump started from', () => {
        reportSurface('stories');
        navigateToSetting(FEED_SHAPERS);
        expect(mockBackListeners).toHaveLength(1);
        reportSurface('profile');
        expect(mockBackListeners[0]()).toBe(true);
        expect(mockNavigateToPage).toHaveBeenLastCalledWith('stories');
        expect(mockBackListeners).toHaveLength(0);
    });

    it('opens the tab for a pushed origin (One interest) without touching its stack', () => {
        reportSurface('interest:abc');
        navigateToSetting(FEED_SHAPERS);
        reportSurface('profile');
        expect(returnToJumpOrigin()).toBe(true);
        expect(mockNavigate).toHaveBeenCalledWith('/logged-in/app_container/feed');
    });

    it('declines once the reader has moved on', () => {
        reportSurface('feed');
        navigateToSetting(FEED_SHAPERS);
        reportSurface('profile');
        reportSurface('world');
        expect(useFocusTargetStore.getState().jump).toBeNull();
        expect(returnToJumpOrigin()).toBe(false);
    });

    it('declines while the destination is not yet showing', () => {
        reportSurface('feed');
        navigateToSetting(FEED_SHAPERS);
        expect(returnToJumpOrigin()).toBe(false);
    });

    it('records no jump from a root push (no surface)', () => {
        navigateToSetting(FEED_SHAPERS);
        expect(useFocusTargetStore.getState().jump).toBeNull();
        expect(mockBackListeners).toHaveLength(0);
    });
});
