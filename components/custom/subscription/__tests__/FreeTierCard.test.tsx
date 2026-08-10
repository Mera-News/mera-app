/* eslint-disable @typescript-eslint/no-require-imports */
// FreeTierCard.test.tsx — the list-header card adopted the same "Free isn't
// free" content and `GlassPanel` chrome NotSubscribedScreen uses.
//
// Not mocking `GlassPanel` itself: rendering the real component is what
// proves the extraction actually wires through (radius/logoSize/testID),
// rather than merely asserting FreeTierCard calls some mock. Its own
// transitive deps (MeraLogo, CardGlassPlate) are mocked because they reach
// reanimated / a native module at import time — same as
// not-subscribed-exit.test.tsx.

import { fireEvent, render } from '@testing-library/react-native';
import React from 'react';

jest.mock('@/components/custom/MeraLogo', () => ({ __esModule: true, default: () => null }));
// The glass plate reaches expo-glass-effect (a native module) at import time.
jest.mock('@/components/custom/cards/CardGlassPlate', () => ({
    CARDS_USE_GLASS: true,
    CardGlassPlate: () => null,
}));
jest.mock('react-native-css-interop/jsx-runtime', () => {
    const R = require('react/jsx-runtime');
    return { jsx: R.jsx, jsxs: R.jsxs, Fragment: R.Fragment };
});
jest.mock('react-native-css-interop/jsx-dev-runtime', () => {
    const R = require('react/jsx-dev-runtime');
    return { jsxDEV: R.jsxDEV, Fragment: R.Fragment };
});

jest.mock('@/components/ui/box', () => { const { View } = require('react-native'); return { Box: (p: any) => <View {...p} /> }; });
jest.mock('@/components/ui/heading', () => { const { Text } = require('react-native'); return { Heading: (p: any) => <Text {...p} /> }; });
jest.mock('@/components/ui/text', () => { const { Text } = require('react-native'); return { Text: (p: any) => <Text {...p} /> }; });
jest.mock('@/components/ui/button', () => {
    const { Pressable, Text } = require('react-native');
    return {
        Button: (p: any) => <Pressable {...p} />,
        ButtonText: (p: any) => <Text {...p} />,
    };
});

jest.mock('react-i18next', () => ({ useTranslation: () => ({ t: (k: string) => k }) }));

const mockPush = jest.fn();
jest.mock('expo-router', () => ({ useRouter: () => ({ push: mockPush }) }));

const mockPresentFreeTierPaywall = jest.fn().mockResolvedValue(undefined);
jest.mock('@/lib/subscription/present-free-tier-paywall', () => ({
    presentFreeTierPaywall: (...a: any[]) => mockPresentFreeTierPaywall(...a),
}));

let mockAiAccess: 'unknown' | 'entitled' | 'locked' = 'locked';
jest.mock('@/lib/stores/subscription-store', () => ({
    useAiAccess: () => mockAiAccess,
}));

import FreeTierCard from '../FreeTierCard';

beforeEach(() => {
    jest.clearAllMocks();
    mockAiAccess = 'locked';
});

describe('FreeTierCard', () => {
    it('renders nothing when the user is not locked (entitled)', () => {
        mockAiAccess = 'entitled';
        const { queryByTestId } = render(<FreeTierCard surface="feed" />);
        expect(queryByTestId('free-tier-card-feed')).toBeNull();
    });

    it('renders nothing during the unknown (cold-start) window', () => {
        mockAiAccess = 'unknown';
        const { queryByTestId } = render(<FreeTierCard surface="feed" />);
        expect(queryByTestId('free-tier-card-feed')).toBeNull();
    });

    it('renders the panel, keyed by surface, when locked', () => {
        const { getByTestId } = render(<FreeTierCard surface="dashboard" />);
        expect(getByTestId('free-tier-card-dashboard')).toBeTruthy();
    });

    // The "Free isn't free" content, ported from NotSubscribedScreen — the
    // title plus all three paragraphs, unconditionally the no-trial one.
    it('renders the title and all three paragraphs, unconditionally para3NoTrial', () => {
        const { getByText, queryByText } = render(<FreeTierCard surface="feed" />);
        expect(getByText('subscription.title')).toBeTruthy();
        expect(getByText('subscription.para1')).toBeTruthy();
        expect(getByText('subscription.para2')).toBeTruthy();
        expect(getByText('subscription.para3NoTrial')).toBeTruthy();
        expect(queryByText('subscription.para3Trial')).toBeNull();
    });

    it('keeps the body testID on paragraph 1 so existing selectors still resolve', () => {
        const { getByTestId } = render(<FreeTierCard surface="feed" />);
        expect(getByTestId('free-tier-card-body-feed').props.children).toBe('subscription.para1');
    });

    it('presents the free-tier paywall, tagged with the surface, on the CTA', async () => {
        const { getByTestId } = render(<FreeTierCard surface="feed" />);
        await fireEvent.press(getByTestId('free-tier-card-cta'));
        expect(mockPresentFreeTierPaywall).toHaveBeenCalledWith('FreeTierCard');
    });

    it('calls the onSeePlans override instead of the paywall when provided', async () => {
        const onSeePlans = jest.fn();
        const { getByTestId } = render(<FreeTierCard surface="feed" onSeePlans={onSeePlans} />);
        await fireEvent.press(getByTestId('free-tier-card-cta'));
        expect(onSeePlans).toHaveBeenCalledTimes(1);
        expect(mockPresentFreeTierPaywall).not.toHaveBeenCalled();
    });

    it('navigates to /tutorials from the learn-more button', () => {
        const { getByTestId } = render(<FreeTierCard surface="feed" />);
        fireEvent.press(getByTestId('free-tier-card-learn'));
        expect(mockPush).toHaveBeenCalledWith('/tutorials');
    });
});
