/* eslint-disable @typescript-eslint/no-require-imports */
// The Feed's status panel opens as a DROPDOWN under the title row, from the
// Mera mark. Captured: the old inline panel grew the header, which re-padded
// the list, and after it closed the list sat ~99pt down. A dropdown changes
// no layout.

import { fireEvent, render } from '@testing-library/react-native';
import React from 'react';

jest.mock('react-native-css-interop/jsx-runtime', () => {
    const R = require('react/jsx-runtime');
    return { jsx: R.jsx, jsxs: R.jsxs, Fragment: R.Fragment };
});
jest.mock('react-native-css-interop/jsx-dev-runtime', () => {
    const R = require('react/jsx-dev-runtime');
    return { jsxDEV: R.jsxDEV, Fragment: R.Fragment };
});
// jest-expo mis-transforms RN's ScrollView native-component file.
jest.mock('react-native', () => {
    const actual = jest.requireActual('react-native');
    const ReactLib = require('react');
    const StubScrollView = ({ children, ...rest }: any) => ReactLib.createElement(actual.View, rest, children);
    StubScrollView.Context = ReactLib.createContext(null);
    return new Proxy(actual, {
        get(target, prop) {
            if (prop === 'ScrollView') return StubScrollView;
            return (target as any)[prop];
        },
    });
});
jest.mock('react-i18next', () => ({ useTranslation: () => ({ t: (k: string) => k }) }));
jest.mock('@/components/custom/for-you/FeedStatusIndicator', () => {
    const { Pressable } = require('react-native');
    return {
        __esModule: true,
        default: (p: any) => (
            <Pressable testID={p.testID} onPress={p.onPress} accessibilityState={{ expanded: p.expanded }} mode={p.mode} />
        ),
    };
});
jest.mock('@/components/custom/for-you/FeedStatusPanel', () => {
    const { View } = require('react-native');
    return {
        __esModule: true,
        STATUS_PANEL_AUTO_COLLAPSE_MS: 3000,
        default: (p: any) => (p.expanded ? <View testID="status-panel" /> : null),
    };
});
const ROW = { x: 20, y: 78, width: 335, height: 45 };
const LAYER = { x: 0, y: 0, width: 375, height: 812 };
jest.mock('@/components/custom/for-you/stats-card-dropdown', () => {
    const actual = jest.requireActual('@/components/custom/for-you/stats-card-dropdown');
    return {
        ...actual,
        measureAnchor: (node: any, done: any) =>
            done(node?.props?.testID === 'feed-status-dropdown-layer' ? LAYER : ROW),
    };
});
jest.mock('@/lib/hooks/use-feed-status-mode', () => ({ useFeedStatusMode: () => 'idle' }));
jest.mock('@/lib/hooks/use-is-focused-safe', () => ({ useIsFocusedSafe: () => true }));
jest.mock('@/lib/navigation/tab-bar', () => ({ useTabBarClearance: () => 83 }));
jest.mock('react-native-safe-area-context', () => ({
    useSafeAreaInsets: () => ({ top: 62, bottom: 83, left: 0, right: 0 }),
}));

import { View } from 'react-native';
import { StatusDropdownLayer, StatusDropdownProvider } from '@/components/custom/for-you/status-dropdown';
import FeedStatusMark from '../FeedStatusMark';

function Harness() {
    const rowRef = React.useRef<View>(null);
    return (
        <StatusDropdownProvider>
            <View ref={rowRef} testID="title-row" />
            <FeedStatusMark mode="idle" anchorRef={rowRef} />
            <StatusDropdownLayer testIDPrefix="feed-status" />
        </StatusDropdownProvider>
    );
}

const HIDDEN = { includeHiddenElements: true } as const;

describe('FeedStatusMark', () => {
    it('opens the panel in the screen layer, directly under the title row', () => {
        const { StyleSheet } = require('react-native');
        const r = render(<Harness />);
        expect(r.queryByTestId('status-panel')).toBeNull();
        fireEvent.press(r.getByTestId('feed-status-indicator'));
        const panel = r.getByTestId('status-panel', HIDDEN);
        let inLayer = false;
        for (let p: any = panel.parent; p; p = p.parent) {
            if (p.props?.testID === 'feed-status-dropdown-layer') inLayer = true;
        }
        expect(inLayer).toBe(true);
        const frame = StyleSheet.flatten(r.getByTestId('feed-status-dropdown', HIDDEN).props.style);
        expect(frame).toMatchObject({ top: 78 + 45, left: 20, width: 335 });
    });

    it('reports the open state on the mark and closes from the backdrop', () => {
        const r = render(<Harness />);
        fireEvent.press(r.getByTestId('feed-status-indicator'));
        expect(r.getByTestId('feed-status-indicator', HIDDEN).props.accessibilityState).toEqual({ expanded: true });
        fireEvent.press(r.getByTestId('feed-status-dropdown-backdrop', HIDDEN));
        expect(r.queryByTestId('status-panel', HIDDEN)).toBeNull();
    });
});

// FeedScreen has no render harness; its header's structure is guarded at the
// SOURCE, comments stripped. The panel must never be back inside the header,
// where its height re-padded the list.
describe('FeedScreen header structure', () => {
    const fs = require('fs');
    const path = require('path');
    const src: string = fs
        .readFileSync(path.resolve(__dirname, '../FeedScreen.tsx'), 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/\/\/.*$/gm, '');

    it('renders no inline FeedStatusPanel', () => {
        expect(src).toContain('<FeedHeaderTitleRow');
        expect(src).not.toContain('<FeedStatusPanel');
    });

    it('wraps the screen in the dropdown provider and mounts the layer', () => {
        expect(src).toContain('<StatusDropdownProvider>');
        expect(src).toContain('<StatusDropdownLayer testIDPrefix="feed-status" />');
    });
});
