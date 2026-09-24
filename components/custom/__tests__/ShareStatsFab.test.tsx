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
// 85, not 34: inside a NativeTabs screen on iOS the tab's own SafeAreaProvider
// reports the tab bar as part of the bottom inset. Mocking the bare 34pt home
// indicator is what let this suite pin a sum that counted the bar twice.
jest.mock('react-native-safe-area-context', () => ({
    useSafeAreaInsets: () => ({ top: 0, bottom: 85, left: 0, right: 0 }),
}));
jest.mock('@/components/custom/GlassSurface', () => {
    const { View } = require('react-native');
    return {
        GLASS_OVER_CONTENT_FILL: 'rgba(18,17,19,0.90)',
        GlassPlate: (p: any) => <View {...p} testID="glass-plate" />,
    };
});

import { fireEvent, render, screen } from '@testing-library/react-native';
import React from 'react';
import { StyleSheet } from 'react-native';
import ShareStatsFab from '../ShareStatsFab';

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

    it('sits 20pt above the tab bar, counting the bar once', () => {
        // On iOS the in-tab inset (85) already contains the bar. The old sum,
        // 20 + inset + TAB_BAR_HEIGHT, put the button 154pt up on device.
        render(<ShareStatsFab onPress={jest.fn()} />);
        const style = flat(screen.getByTestId('dashboard-history-share').props.style);
        expect(style.bottom).toBe(20 + 85);
        expect(style.right).toBe(20);
    });

    it('always paints a solid base under the glass', () => {
        // The glass plate alone could paint nothing and leave a bare icon.
        render(<ShareStatsFab onPress={jest.fn()} />);
        const base = flat(
            StyleSheet.flatten(
                screen.getByTestId('dashboard-history-share-base', { includeHiddenElements: true })
                    .props.style,
            ),
        );
        expect(base.backgroundColor).toBe('rgba(18,17,19,0.90)');
        expect(base.borderRadius).toBe(25);
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
