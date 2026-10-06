/* eslint-disable @typescript-eslint/no-require-imports */
import { act, fireEvent, render } from '@testing-library/react-native';
import React from 'react';
import { AccessibilityInfo, Text } from 'react-native';

jest.mock('expo-router', () => ({
    router: { push: jest.fn(), navigate: jest.fn() },
}));
jest.mock('@/components/custom/nav/navigate-to-page', () => ({ navigateToPage: jest.fn() }));

import { navigateToSetting, resetPendingFocus } from '@/lib/navigation/focus-target';
import FocusTarget, { FocusHostProvider } from '../FocusTarget';

const host = { contentRef: { current: null }, scrollToY: jest.fn() };

function screen() {
    return render(
        <FocusHostProvider host={host}>
            <FocusTarget id="profile.facts" announce="Facts">
                <Text>facts card</Text>
            </FocusTarget>
            <FocusTarget id="profile.places" announce="Places">
                <Text>places card</Text>
            </FocusTarget>
        </FocusHostProvider>,
    );
}

function layoutAll(r: ReturnType<typeof render>) {
    for (const label of ['facts card', 'places card']) {
        fireEvent(r.getByText(label).parent!.parent!, 'layout', { nativeEvent: { layout: { x: 0, y: 0, width: 1, height: 1 } } });
    }
}

beforeEach(() => {
    resetPendingFocus();
    jest.clearAllMocks();
    jest.spyOn(AccessibilityInfo, 'isReduceMotionEnabled').mockResolvedValue(false);
    jest.spyOn(AccessibilityInfo, 'announceForAccessibility').mockImplementation(() => {});
    jest.spyOn(AccessibilityInfo, 'sendAccessibilityEvent').mockImplementation(() => {});
});

it('highlights each pending target once laid out, and announces only the first', async () => {
    navigateToSetting(['profile.facts', 'profile.places']);
    const r = screen();
    await act(async () => { layoutAll(r); });
    expect(r.getByTestId('focus-highlight-profile.facts')).toBeTruthy();
    expect(r.getByTestId('focus-highlight-profile.places')).toBeTruthy();
    expect(AccessibilityInfo.announceForAccessibility).toHaveBeenCalledTimes(1);
    expect(AccessibilityInfo.announceForAccessibility).toHaveBeenCalledWith('Facts');
});

it('shows nothing without a pending jump', async () => {
    const r = screen();
    await act(async () => { layoutAll(r); });
    expect(r.queryByTestId('focus-highlight-profile.facts')).toBeNull();
});

it('is one-shot: a second layout does not light it again', async () => {
    navigateToSetting('profile.facts');
    const r = screen();
    await act(async () => { layoutAll(r); });
    await act(async () => { layoutAll(r); });
    expect(AccessibilityInfo.announceForAccessibility).toHaveBeenCalledTimes(1);
});
