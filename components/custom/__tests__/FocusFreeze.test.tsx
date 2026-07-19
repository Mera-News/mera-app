import { render } from '@testing-library/react-native';
import React from 'react';
import { Text } from 'react-native';

// react-freeze's `Freeze` hides its previous committed output via a Suspense/
// Offscreen trick rather than unmounting it, which react-test-renderer still
// reports as present to `queryByText`. Mock it to its documented contract
// (render children, or `placeholder` when frozen) so this test exercises
// FocusFreeze's own grace-period/timer logic, not react-freeze's internals.
jest.mock('react-freeze', () => ({
    Freeze: ({ freeze, children, placeholder }: { freeze: boolean; children: React.ReactNode; placeholder?: React.ReactNode }) =>
        freeze ? (placeholder ?? null) : children,
}));

// eslint-disable-next-line import/first
import FocusFreeze from '@/components/custom/FocusFreeze';

/**
 * FocusFreeze uses `useIsFocused()` by default, which throws outside a
 * navigator. These tests exercise the `focused` override prop instead, so
 * they don't need a NavigationContainer — see the prop's doc comment in
 * FocusFreeze.tsx for why the override exists.
 */
describe('FocusFreeze', () => {
    beforeEach(() => {
        jest.useFakeTimers();
    });

    afterEach(() => {
        jest.useRealTimers();
    });

    it('renders children immediately when focused', () => {
        const { getByText } = render(
            <FocusFreeze focused>
                <Text>hello</Text>
            </FocusFreeze>,
        );
        expect(getByText('hello')).toBeTruthy();
    });

    it('keeps children mounted during the blur grace period', () => {
        const { getByText, rerender } = render(
            <FocusFreeze focused>
                <Text>hello</Text>
            </FocusFreeze>,
        );
        rerender(
            <FocusFreeze focused={false}>
                <Text>hello</Text>
            </FocusFreeze>,
        );
        // Grace period hasn't elapsed yet — still rendered.
        expect(getByText('hello')).toBeTruthy();
    });

    it('freezes (unmounts the visible subtree) after the blur grace period elapses', () => {
        const { queryByText, rerender } = render(
            <FocusFreeze focused={false}>
                <Text>hello</Text>
            </FocusFreeze>,
        );
        expect(queryByText('hello')).toBeTruthy();

        jest.advanceTimersByTime(300);
        rerender(
            <FocusFreeze focused={false}>
                <Text>hello</Text>
            </FocusFreeze>,
        );
        expect(queryByText('hello')).toBeNull();
    });

    it('unfreezes immediately when focus returns, without waiting out a grace period', () => {
        const { queryByText, rerender } = render(
            <FocusFreeze focused={false}>
                <Text>hello</Text>
            </FocusFreeze>,
        );
        jest.advanceTimersByTime(300);
        rerender(
            <FocusFreeze focused={false}>
                <Text>hello</Text>
            </FocusFreeze>,
        );
        expect(queryByText('hello')).toBeNull();

        rerender(
            <FocusFreeze focused>
                <Text>hello</Text>
            </FocusFreeze>,
        );
        expect(queryByText('hello')).toBeTruthy();
    });
});
