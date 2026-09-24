/* eslint-disable @typescript-eslint/no-require-imports */
import { fireEvent, render } from '@testing-library/react-native';
import React from 'react';

jest.mock('react-native-css-interop/jsx-runtime', () => {
    const ReactJSXRuntime = require('react/jsx-runtime');
    return { jsx: ReactJSXRuntime.jsx, jsxs: ReactJSXRuntime.jsxs, Fragment: ReactJSXRuntime.Fragment };
});
jest.mock('react-native-css-interop/jsx-dev-runtime', () => {
    const ReactJSXRuntime = require('react/jsx-dev-runtime');
    return { jsxDEV: ReactJSXRuntime.jsxDEV, Fragment: ReactJSXRuntime.Fragment };
});

jest.mock('react-i18next', () => ({
    useTranslation: () => ({
        t: (key: string, v?: Record<string, unknown>) => (v ? `${key}:${JSON.stringify(v)}` : key),
    }),
}));

// jest-expo mis-transforms RN's ScrollView native-component file ("Unexpected
// token 'export'") — same trap documented in AddLocationView.test.tsx /
// ScopeChipRow.test.tsx. Proxy RN so ScrollView renders as a plain View; every
// other export stays lazy/real.
jest.mock('react-native', () => {
    const actual = jest.requireActual('react-native');
    const ReactLib = require('react');
    const StubScrollView = ({ children, ...rest }: any) => ReactLib.createElement(actual.View, rest, children);
    StubScrollView.Context = ReactLib.createContext(null);
    return new Proxy(actual, {
        get(target, prop) {
            if (prop === 'ScrollView') {
                return StubScrollView;
            }
            return (target as any)[prop];
        },
    });
});

// Emit a fixed unseen total synchronously on subscribe.
let mockEmitTotal = 3;
jest.mock('@/lib/database/services/tracked-story-service', () => ({
    observeUnseenTotal: () => ({
        subscribe: (observer: any) => {
            observer.next(mockEmitTotal);
            return { unsubscribe: jest.fn() };
        },
    }),
}));

jest.mock('@/components/ui/hstack', () => {
    const { View } = require('react-native');
    return { HStack: (props: any) => <View {...props} /> };
});
jest.mock('@/components/ui/pressable', () => {
    const { Pressable: RNPressable } = require('react-native');
    return { Pressable: RNPressable };
});
jest.mock('@/components/ui/text', () => {
    const { Text: RNText } = require('react-native');
    return { Text: RNText };
});
jest.mock('@/components/custom/GlassSurface', () => {
    const { View } = require('react-native');
    return {
        GlassPanel: ({ children, radius }: any) => (
            <View testID="glass-chip" radius={radius}>
                {children}
            </View>
        ),
    };
});
jest.mock('@expo/vector-icons', () => {
    const { View } = require('react-native');
    return { MaterialIcons: (props: any) => <View {...props} /> };
});

import ForYouSubTabs, { subTabA11yRoles } from '../ForYouSubTabs';

describe('ForYouSubTabs', () => {
    beforeEach(() => {
        mockEmitTotal = 3;
    });

    it('renders a pill per sub-tab', () => {
        const { getByText } = render(
            <ForYouSubTabs activeSubTab="feed" onSelect={jest.fn()} />,
        );
        expect(getByText('forYou.subTabFeed')).toBeTruthy();
        expect(getByText('forYou.subTabStories')).toBeTruthy();
        expect(getByText('forYou.subTabSaved')).toBeTruthy();
        expect(getByText('forYou.subTabHistory')).toBeTruthy();
        expect(getByText('factCheck.dashboard.title')).toBeTruthy();
    });

    // Position is the requirement, not just presence: "after History".
    // Fact checks sits BEFORE History. The row scrolls horizontally, so the
    // last pill is the one a reader has to already know is there — and a fact
    // check is something they deliberately asked for and are waiting on, where
    // History is a passive record. Order encodes that, so it is asserted.
    it('places Fact checks before History', () => {
        const { getByTestId } = render(
            <ForYouSubTabs activeSubTab="feed" onSelect={jest.fn()} />,
        );
        const row = getByTestId('dashboard-subtabs-row');
        const keys: string[] = [];
        const walk = (node: any) => {
            if (!node || typeof node !== 'object') return;
            const id = node.props?.testID;
            if (typeof id === 'string' && /^dashboard-tab-[a-zA-Z]+$/.test(id)) {
                keys.push(id.replace('dashboard-tab-', ''));
            }
            React.Children.forEach(node.props?.children, walk);
        };
        walk(row);
        expect(keys).toEqual(['feed', 'stories', 'saved', 'factChecks', 'history']);
        // The assertion this test is actually ABOUT, restated so a future
        // addition to the row cannot dilute it into a bare list comparison.
        expect(keys.indexOf('factChecks')).toBeLessThan(keys.indexOf('history'));
    });

    it('fires onSelect with factChecks when the Fact checks pill is tapped', () => {
        const onSelect = jest.fn();
        const { getByText } = render(
            <ForYouSubTabs activeSubTab="feed" onSelect={onSelect} />,
        );
        fireEvent.press(getByText('factCheck.dashboard.title'));
        expect(onSelect).toHaveBeenCalledWith('factChecks');
    });

    it('marks the Fact checks pill active like any other', () => {
        const { getByLabelText } = render(
            <ForYouSubTabs activeSubTab="factChecks" onSelect={jest.fn()} />,
        );
        expect(
            getByLabelText('factCheck.dashboard.title').props.accessibilityState,
        ).toMatchObject({ selected: true });
    });

    it('shows the unseen tracked-story badge on the Stories pill', () => {
        const { getByText } = render(
            <ForYouSubTabs activeSubTab="feed" onSelect={jest.fn()} />,
        );
        expect(getByText('3', { includeHiddenElements: true })).toBeTruthy();
    });

    it('hides the badge when there are no unseen stories', () => {
        mockEmitTotal = 0;
        const { queryByText } = render(
            <ForYouSubTabs activeSubTab="feed" onSelect={jest.fn()} />,
        );
        expect(queryByText('0', { includeHiddenElements: true })).toBeNull();
    });

    it('fires onSelect with the tapped sub-tab', () => {
        const onSelect = jest.fn();
        const { getByText } = render(
            <ForYouSubTabs activeSubTab="feed" onSelect={onSelect} />,
        );
        fireEvent.press(getByText('forYou.subTabStories'));
        expect(onSelect).toHaveBeenCalledWith('stories');
    });

    it('fires onSelect with history when the History pill is tapped', () => {
        const onSelect = jest.fn();
        const { getByText } = render(
            <ForYouSubTabs activeSubTab="feed" onSelect={onSelect} />,
        );
        fireEvent.press(getByText('forYou.subTabHistory'));
        expect(onSelect).toHaveBeenCalledWith('history');
    });

    it('marks the active pill via accessibilityState', () => {
        const { getByLabelText } = render(
            <ForYouSubTabs activeSubTab="saved" onSelect={jest.fn()} />,
        );
        expect(getByLabelText('forYou.subTabSaved').props.accessibilityState).toMatchObject({
            selected: true,
        });
    });
});


describe('ForYouSubTabs: every pill is reachable and announced (F19)', () => {
    it('draws no fade overlay on either edge: a painted fade over the translucent header read as dark blocks', () => {
        // No mask is available without a native dependency, and a gradient to a
        // single colour cannot match a header that moves over the backdrop. The
        // half-visible last pill is the cue that the row continues.
        const { getByTestId, queryByTestId } = render(
            <ForYouSubTabs activeSubTab="feed" onSelect={jest.fn()} />,
        );
        const scroll = getByTestId('dashboard-subtabs-scroll');
        fireEvent(scroll, 'layout', { nativeEvent: { layout: { width: 362, height: 40, x: 0, y: 0 } } });
        fireEvent(scroll, 'contentSizeChange', 570, 40);
        fireEvent(scroll, 'scroll', { nativeEvent: { contentOffset: { x: 100, y: 0 } } });
        expect(queryByTestId('dashboard-subtabs-fade-right')).toBeNull();
        expect(queryByTestId('dashboard-subtabs-fade-left')).toBeNull();
    });

    it('exposes the pills as tabs inside a tab bar, with the selected one marked', () => {
        const { getByTestId } = render(<ForYouSubTabs activeSubTab="saved" onSelect={jest.fn()} />);
        expect(getByTestId('dashboard-subtabs-list').props.accessibilityRole).toBe('tabbar');
        const saved = getByTestId('dashboard-tab-saved');
        // iOS: a tab bar item is a button (see the roles block below).
        expect(saved.props.accessibilityRole).toBe('button');
        expect(saved.props.accessibilityState).toEqual({ selected: true });
        expect(getByTestId('dashboard-tab-feed').props.accessibilityState).toEqual({ selected: false });
    });
});

describe('ForYouSubTabs: full-bleed row', () => {
    const flat = (st: any) => (Array.isArray(st) ? Object.assign({}, ...st.filter(Boolean)) : st ?? {});

    it('bleeds past the header padding so pills clip at the SCREEN edge, not inside the header', () => {
        const { getByTestId } = render(<ForYouSubTabs activeSubTab="feed" onSelect={jest.fn()} bleed={20} />);
        expect(flat(getByTestId('dashboard-subtabs-row').props.style).marginHorizontal).toBe(-20);
        const content = flat(getByTestId('dashboard-subtabs-scroll').props.contentContainerStyle);
        // The same padding back inside the content, so at rest the first pill
        // still lines up with the title.
        expect(content.paddingHorizontal).toBe(20);
    });

    it('stays inset with no bleed (standalone use)', () => {
        const { getByTestId } = render(<ForYouSubTabs activeSubTab="feed" onSelect={jest.fn()} />);
        expect(flat(getByTestId('dashboard-subtabs-row').props.style).marginHorizontal ?? 0).toBe(0);
    });
});

// Owner: "make the top pills the same style as the pills in the Explore tab".
// The tokens below are Explore's ScopeChipRow, copied: its component is typed
// to places and carries an add chip and a long-press remove, so it is not
// reusable here. Class names cannot show colour (the device capture does);
// what these pin is that the tokens are Explore's and the orange outline and
// orange label are gone.
describe('ForYouSubTabs: Explore pill style', () => {
    const ACCENT = 'rgb(231, 138, 83)';
    // The pressable is the transparent 44pt frame; the visible chip is inside.
    const glassIn = (node: any) => node.findAll((n: any) => n.props?.testID === 'glass-chip')[0] ?? null;

    it('draws an inactive pill as a round glass chip with a white label and no orange outline', () => {
        const { getByTestId, getByText } = render(<ForYouSubTabs activeSubTab="feed" onSelect={jest.fn()} />);
        const saved = getByTestId('dashboard-tab-saved');
        const glass = glassIn(saved);
        expect(glass).not.toBeNull();
        expect(glass.props.radius).toBe(999);
        expect(getByTestId('dashboard-tab-saved-chip').props.className ?? '').not.toMatch(/border-primary/);
        const label = getByText('forYou.subTabSaved');
        expect(label.props.className).toContain('text-white');
        expect(label.props.className).not.toContain('text-primary');
    });

    it('fills the active pill with the accent and a black label, outside the glass', () => {
        const { getByTestId, getByText } = render(<ForYouSubTabs activeSubTab="saved" onSelect={jest.fn()} />);
        const saved = getByTestId('dashboard-tab-saved');
        expect(glassIn(saved)).toBeNull();
        expect(getByTestId('dashboard-tab-saved-chip').props.className).toContain('bg-primary-400');
        expect(getByText('forYou.subTabSaved').props.className).toContain('text-black');
    });

    it('keeps the icons, as Explore does: accent when inactive, black when active', () => {
        const { getByTestId } = render(<ForYouSubTabs activeSubTab="saved" onSelect={jest.fn()} />);
        const icon = (key: string) =>
            getByTestId(`dashboard-tab-${key}`).findAll((n: any) => n.props?.name !== undefined && n.props?.size === 16)[0];
        expect(icon('feed').props.color).toBe(ACCENT);
        expect(icon('saved').props.color).toBe('#000000');
    });
});

// Captured on the iOS sim: every pill reported as `Other`. React Native maps
// only `tabbar` to a UIKit trait; `tab` maps to NONE on iOS
// (accessibilityPropsConversions.h), so a pill carrying it is a traitless
// element. A UIKit tab bar item is a BUTTON inside a TabBar-trait container,
// which is what VoiceOver turns into "tab, N of 5". Android has real
// tab/tablist roles.
describe('ForYouSubTabs: roles on the element that takes the press', () => {
    it('uses button-in-tabbar on iOS and tab-in-tablist on Android', () => {
        expect(subTabA11yRoles('ios')).toEqual({ row: 'tabbar', pill: 'button' });
        expect(subTabA11yRoles('android')).toEqual({ row: 'tablist', pill: 'tab' });
    });

    it('puts the pill role and selected state on the pressable itself, and pressing THAT element selects', () => {
        const onSelect = jest.fn();
        const { getByTestId } = render(<ForYouSubTabs activeSubTab="feed" onSelect={onSelect} />);
        const { pill } = subTabA11yRoles(require('react-native').Platform.OS);
        const saved = getByTestId('dashboard-tab-saved');
        expect(saved.props.accessibilityRole).toBe(pill);
        expect(saved.props.accessibilityState).toEqual({ selected: false });
        expect(getByTestId('dashboard-tab-feed').props.accessibilityState).toEqual({ selected: true });
        // The element carrying the role is the one that handles the press:
        // no ancestor between it and the handler.
        expect(typeof saved.props.onClick === 'function' || typeof saved.props.onResponderRelease === 'function').toBe(true);
        fireEvent.press(saved);
        expect(onSelect).toHaveBeenCalledWith('saved');
    });

    it('puts the row role on the pills\' container', () => {
        const { getByTestId } = render(<ForYouSubTabs activeSubTab="feed" onSelect={jest.fn()} />);
        const { row } = subTabA11yRoles(require('react-native').Platform.OS);
        expect(getByTestId('dashboard-subtabs-list').props.accessibilityRole).toBe(row);
    });
});

// Captured: the Stories badge was its own accessibility element, and the
// pills were 35-37pt tall.
describe('ForYouSubTabs: one element per pill, 44pt tall', () => {
    const flat = (st: any) => require('react-native').StyleSheet.flatten(st) ?? {};

    it('folds the unseen count into the Stories pill label and hides the badge', () => {
        const { getByTestId } = render(<ForYouSubTabs activeSubTab="feed" onSelect={jest.fn()} />);
        expect(getByTestId('dashboard-tab-stories').props.accessibilityLabel).toBe(
            'forYou.subTabStories, trackedStories.updatesBadge:{"count":3}',
        );
        const badge = getByTestId('dashboard-tab-stories-badge', { includeHiddenElements: true });
        expect(badge.props.accessibilityElementsHidden).toBe(true);
        expect(badge.props.importantForAccessibility).toBe('no-hide-descendants');
        expect(badge.props.accessibilityLabel).toBeUndefined();
    });

    it('keeps the plain label with no unseen stories', () => {
        mockEmitTotal = 0;
        const { getByTestId } = render(<ForYouSubTabs activeSubTab="feed" onSelect={jest.fn()} />);
        expect(getByTestId('dashboard-tab-stories').props.accessibilityLabel).toBe('forYou.subTabStories');
    });

    it('pads each pressable to a 44pt frame and pulls the row back by the same amount', () => {
        const { getByTestId } = render(<ForYouSubTabs activeSubTab="feed" onSelect={jest.fn()} />);
        const pad = flat(getByTestId('dashboard-tab-saved').props.style).paddingVertical;
        // The chip is 35-37pt; 2 x pad takes the frame to 44 or more.
        expect(35 + 2 * pad).toBeGreaterThanOrEqual(44);
        // ...and the row gives the padding back, so the header does not grow.
        expect(flat(getByTestId('dashboard-subtabs-row').props.style).marginVertical).toBe(-pad);
    });
});
