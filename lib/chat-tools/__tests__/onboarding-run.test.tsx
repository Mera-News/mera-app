// The D29 exemption. What matters is that it cannot be obtained, forged, or
// held outside a live wizard run — a widened gate here hands the whole free
// cohort an unmetered chat, and it would look exactly like working code.

import { renderHook, act } from '@testing-library/react-native';

// The mint refuses unless the user is actually on the free tier, so these
// tests have to put them there. `serverTier` is not decoration: a null tier is
// the cold-start 'unknown' window, and the mint must refuse during it.
let mockAiAccess = 'locked';
let mockServerTier: string | null = 'none';
jest.mock('@/lib/stores/subscription-store', () => ({
    getAiAccess: () => mockAiAccess,
    useSubscriptionStore: Object.assign(
        (selector: (s: { serverTier: string | null }) => unknown) =>
            selector({ serverTier: mockServerTier }),
        { getState: () => ({ serverTier: mockServerTier }) },
    ),
}));

import {
    isOnboardingRunActive,
    useOnboardingRunToken,
    type OnboardingRunToken,
} from '../onboarding-run';

beforeEach(() => {
    mockAiAccess = 'locked';
    mockServerTier = 'none';
});

describe('isOnboardingRunActive', () => {
    it('refuses absent tokens, so every guard defaults to NO exemption', () => {
        expect(isOnboardingRunActive(null)).toBe(false);
        expect(isOnboardingRunActive(undefined)).toBe(false);
    });

    it('refuses a structural look-alike smuggled in through a cast', () => {
        // The type is uninhabitable outside the module, so the only way to get
        // here is `as` — and identity, not shape, is the credential.
        const forged = {} as unknown as OnboardingRunToken;

        expect(isOnboardingRunActive(forged)).toBe(false);
    });

    it('refuses a frozen empty object, the exact shape the module mints', () => {
        const lookalike = Object.freeze({}) as unknown as OnboardingRunToken;

        expect(isOnboardingRunActive(lookalike)).toBe(false);
    });
});

describe('useOnboardingRunToken', () => {
    it('mints nothing while inactive', () => {
        const { result } = renderHook(() => useOnboardingRunToken(false));

        expect(result.current).toBeNull();
    });

    it('mints a live token while active', () => {
        const { result } = renderHook(() => useOnboardingRunToken(true));

        expect(result.current).not.toBeNull();
        expect(isOnboardingRunActive(result.current)).toBe(true);
    });

    it('REVOKES on unmount, so a stashed token stops working', () => {
        const { result, unmount } = renderHook(() => useOnboardingRunToken(true));
        const token = result.current;
        expect(isOnboardingRunActive(token)).toBe(true);

        unmount();

        // The whole point of a run-scoped credential: holding a reference must
        // not extend the run.
        expect(isOnboardingRunActive(token)).toBe(false);
    });

    it('revokes when the run goes inactive without unmounting', () => {
        const { result, rerender } = renderHook<
            OnboardingRunToken | null,
            { active: boolean }
        >(({ active }) => useOnboardingRunToken(active), {
            initialProps: { active: true },
        });
        const token = result.current;
        expect(isOnboardingRunActive(token)).toBe(true);

        act(() => rerender({ active: false }));

        expect(result.current).toBeNull();
        expect(isOnboardingRunActive(token)).toBe(false);
    });

    it('refuses a SECOND concurrent run rather than widening the gate', () => {
        const first = renderHook(() => useOnboardingRunToken(true));
        expect(isOnboardingRunActive(first.result.current)).toBe(true);

        const second = renderHook(() => useOnboardingRunToken(true));

        // Null, not a second token: two live exemptions is a bug, and this
        // makes it a visible one.
        expect(second.result.current).toBeNull();

        first.unmount();
        second.unmount();
    });

    it('refuses to mint for an ENTITLED user: no gate, nothing to exempt', () => {
        mockAiAccess = 'entitled';
        mockServerTier = 'starter';

        const { result } = renderHook(() => useOnboardingRunToken(true));

        expect(result.current).toBeNull();
    });

    it('refuses to mint during the cold-start unknown window', () => {
        // A 'locked' reading the server has not confirmed is not the free
        // tier, it is an unanswered question.
        mockServerTier = null;

        const { result } = renderHook(() => useOnboardingRunToken(true));

        expect(result.current).toBeNull();
    });

    it('MINTS once the server resolves, without a remount', () => {
        // The race the reactive dep exists for. The wizard mounts during the
        // unknown window, so a mint evaluated once at mount would refuse
        // forever and strand the exact zero-fact user D29 rescues.
        mockServerTier = null;
        const { result, rerender } = renderHook(() => useOnboardingRunToken(true));
        expect(result.current).toBeNull();

        mockServerTier = 'none';
        act(() => rerender(undefined));

        expect(isOnboardingRunActive(result.current)).toBe(true);
    });

    it('lets a later run start once the previous one has ended', () => {
        const first = renderHook(() => useOnboardingRunToken(true));
        first.unmount();

        const second = renderHook(() => useOnboardingRunToken(true));

        expect(isOnboardingRunActive(second.result.current)).toBe(true);
        second.unmount();
    });
});
