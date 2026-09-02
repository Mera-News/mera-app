// The D29 exemption. What matters is that it cannot be obtained, forged, or
// held outside a live wizard run — a widened gate here hands the whole free
// cohort an unmetered chat, and it would look exactly like working code.

import { renderHook, act } from '@testing-library/react-native';

import {
    isOnboardingRunActive,
    useOnboardingRunToken,
    type OnboardingRunToken,
} from '../onboarding-run';

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
        const { result, rerender } = renderHook(
            ({ active }) => useOnboardingRunToken(active),
            { initialProps: { active: true } },
        );
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

    it('lets a later run start once the previous one has ended', () => {
        const first = renderHook(() => useOnboardingRunToken(true));
        first.unmount();

        const second = renderHook(() => useOnboardingRunToken(true));

        expect(isOnboardingRunActive(second.result.current)).toBe(true);
        second.unmount();
    });
});
