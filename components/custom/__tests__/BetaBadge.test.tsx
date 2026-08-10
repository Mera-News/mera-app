// BetaBadge — a trivial pill, so the tests cover its actual contract: the
// copy always comes from `common.beta` (never a hardcoded Latin "BETA",
// which would be wrong in scripts like ja/zh/ru/ar/ko/th/hi), it never
// crushes under Dynamic Type (`shrink-0`), and its testID defaults sensibly
// while staying overridable for callers that need more than one on screen.
/* eslint-disable @typescript-eslint/no-require-imports */

jest.mock('react-i18next', () => ({
    useTranslation: () => ({ t: (key: string) => key }),
}));
jest.mock('@/components/ui/box', () => {
    const { View } = require('react-native');
    return { Box: (p: any) => <View {...p} /> };
});
jest.mock('@/components/ui/text', () => {
    const { Text } = require('react-native');
    return { Text };
});

import { render } from '@testing-library/react-native';
import React from 'react';
import BetaBadge from '../BetaBadge';

describe('BetaBadge', () => {
    it('renders the common.beta translation key, never a hardcoded "BETA"', () => {
        const { getByText, queryByText } = render(<BetaBadge />);
        expect(getByText('common.beta')).toBeTruthy();
        expect(queryByText('BETA')).toBeNull();
    });

    it('never grows past its chrome tier under Dynamic Type', () => {
        const { getByText } = render(<BetaBadge />);
        expect(getByText('common.beta').props.scaleTier).toBe('chrome');
    });

    it('carries shrink-0 so it never gets crushed by a long sibling title', () => {
        const { getByTestId } = render(<BetaBadge />);
        expect(getByTestId('beta-badge').props.className).toContain('shrink-0');
    });

    it('defaults its testID and accepts an override for multiple badges on one screen', () => {
        const { getByTestId } = render(<BetaBadge testID="mera-protocol-fact-check-beta" />);
        expect(getByTestId('mera-protocol-fact-check-beta')).toBeTruthy();
    });
});
