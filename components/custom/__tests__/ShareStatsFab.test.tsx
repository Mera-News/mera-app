// ShareStatsFab — opens the reading-statistics share screen from the
// Dashboard's History list.
//
// It exists as a FAB rather than a row because the row version wrapped itself
// in `paddingTop: headerHeight` to clear the collapsing header, while
// VisitedPublicationsList pads by `headerHeight` too. Two offsets for one
// header left a screen-tall gap above the first publication, which is exactly
// what the user reported.
/* eslint-disable @typescript-eslint/no-require-imports */

jest.mock('react-i18next', () => ({
    useTranslation: () => ({ t: (k: string) => k }),
}));
jest.mock('react-native-safe-area-context', () => ({
    useSafeAreaInsets: () => ({ top: 0, bottom: 34, left: 0, right: 0 }),
}));
jest.mock('@/components/custom/GlassSurface', () => {
    const { View } = require('react-native');
    return { GlassPlate: (p: any) => <View {...p} testID="glass-plate" /> };
});

import { fireEvent, render, screen } from '@testing-library/react-native';
import React from 'react';
import ShareStatsFab from '../ShareStatsFab';
import { TAB_BAR_HEIGHT } from '@/lib/navigation/tab-bar';

const flat = (style: any) =>
    Array.isArray(style) ? Object.assign({}, ...style.filter(Boolean)) : style;

describe('ShareStatsFab', () => {
    it('floats, so it adds no vertical space to the list behind it', () => {
        // The whole point. A FAB is absolutely positioned and therefore
        // contributes nothing to layout; the row it replaced contributed a
        // second headerHeight.
        render(<ShareStatsFab onPress={jest.fn()} />);
        expect(flat(screen.getByTestId('dashboard-history-share').props.style).position).toBe(
            'absolute',
        );
    });

    it('clears the tab bar and the home indicator, not just one of them', () => {
        // TAB_BAR_HEIGHT is a conservative estimate of the native bar rather
        // than its measured height, so it is clearance to respect and not a
        // number to sit flush against.
        render(<ShareStatsFab onPress={jest.fn()} />);
        const style = flat(screen.getByTestId('dashboard-history-share').props.style);
        expect(style.bottom).toBe(20 + 34 + TAB_BAR_HEIGHT);
        expect(style.right).toBe(20);
    });

    it('carries a label, because it is an icon with no text', () => {
        render(<ShareStatsFab onPress={jest.fn()} />);
        expect(
            screen.getByTestId('dashboard-history-share').props.accessibilityLabel,
        ).toBe('shareStats.entryA11y');
    });

    it('opens the share screen when pressed', () => {
        const onPress = jest.fn();
        render(<ShareStatsFab onPress={onPress} />);
        fireEvent.press(screen.getByTestId('dashboard-history-share'));
        expect(onPress).toHaveBeenCalledTimes(1);
    });
});

describe('the History pane pads for the header exactly once', () => {
    it('does not wrap the share control in its own headerHeight padding', () => {
        // The regression this file exists for. If a future change puts the
        // control back in a padded row, the list below it still pads for the
        // same header and the gap returns.
        const fs = require('fs');
        const path = require('path');
        const src = fs.readFileSync(
            path.resolve(__dirname, '../for-you/ForYouScreen.tsx'),
            'utf8',
        );
        const history = src.slice(
            src.indexOf('testID="dashboard-history-content"'),
            src.indexOf('Fact checks (lazy-mounted'),
        );
        const code = history.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
        const paddings = code.match(/paddingTop:\s*headerHeight/g) ?? [];
        expect(paddings).toHaveLength(0);
        expect(code).toMatch(/<ShareStatsFab/);
    });
});
