/* eslint-disable @typescript-eslint/no-require-imports */
// The Dashboard's Overview stats card. It carries the article-count sentence
// that left the header, and opens the same status body the Feed's mark opens,
// closing it after the same delay (owner: "make them similar"). The disclosure
// hook is REAL here: the auto-hide is the behaviour under test.

import { act, fireEvent, render } from '@testing-library/react-native';
import React from 'react';

jest.mock('react-native-css-interop/jsx-runtime', () => {
    const R = require('react/jsx-runtime');
    return { jsx: R.jsx, jsxs: R.jsxs, Fragment: R.Fragment };
});
jest.mock('react-native-css-interop/jsx-dev-runtime', () => {
    const R = require('react/jsx-dev-runtime');
    return { jsxDEV: R.jsxDEV, Fragment: R.Fragment };
});
// jest-expo mis-transforms RN's ScrollView and Modal native-component files
// ("Unexpected token 'export'"); same proxy ForYouSubTabs.test.tsx uses. The
// Modal stub renders its children only while visible, as the real one does.
jest.mock('react-native', () => {
    const actual = jest.requireActual('react-native');
    const ReactLib = require('react');
    const StubScrollView = ({ children, ...rest }: any) => ReactLib.createElement(actual.View, rest, children);
    StubScrollView.Context = ReactLib.createContext(null);
    function Modal({ visible, children }: any) {
        return visible ? ReactLib.createElement(actual.View, { testID: 'rn-modal' }, children) : null;
    }
    return new Proxy(actual, {
        get(target, prop) {
            if (prop === 'ScrollView') return StubScrollView;
            if (prop === 'Modal') return Modal;
            return (target as any)[prop];
        },
    });
});
jest.mock('react-i18next', () => ({
    useTranslation: () => ({ t: (key: string) => key }),
}));
jest.mock('@expo/vector-icons', () => {
    const { View } = require('react-native');
    return { MaterialIcons: (p: any) => <View testID={`icon-${p.name}`} /> };
});
jest.mock('@/components/ui/text', () => {
    const { Text } = require('react-native');
    return { Text: (p: any) => <Text {...p} /> };
});
jest.mock('@/components/ui/hstack', () => {
    const { View } = require('react-native');
    return { HStack: (p: any) => <View {...p} /> };
});
jest.mock('@/components/ui/pressable', () => {
    const { Pressable } = require('react-native');
    return { Pressable };
});
jest.mock('@/components/custom/GlassSurface', () => {
    const { View } = require('react-native');
    return { GlassPanel: (p: any) => <View testID={p.testID}>{p.children}</View> };
});
let mockArticleCount = 12;
jest.mock('@/lib/hooks/use-feed-counts', () => ({
    useFeedCounts: () => ({ articleCount: mockArticleCount }),
}));
let mockMode = 'idle';
jest.mock('@/lib/hooks/use-feed-status-mode', () => ({ useFeedStatusMode: () => mockMode }));
jest.mock('../FeedStatsSentence', () => {
    const { View } = require('react-native');
    return { __esModule: true, default: () => <View testID="stats-sentence" /> };
});
// The panel has its own suite; here it only has to be identifiable, and to
// expose the navigate hook its "Manage plan" pill calls. The delay constant is
// the REAL one, so this suite fails if the two tabs drift apart.
jest.mock('../FeedStatusPanel', () => {
    const { View, Pressable } = require('react-native');
    const actual = jest.requireActual('../FeedStatusPanel');
    return {
        STATUS_PANEL_AUTO_COLLAPSE_MS: actual.STATUS_PANEL_AUTO_COLLAPSE_MS,
        __esModule: true,
        default: (p: any) =>
            p.expanded ? (
                <View testID={`status-panel-${p.mode}`}>
                    <Pressable testID="panel-manage-plan" onPress={() => p.onBeforeNavigate?.()} />
                </View>
            ) : null,
    };
});
// FeedStatusPanel's real module pulls reanimated and the processing snapshot;
// requireActual above only needs the constant, so stub what it imports.
jest.mock('react-native-reanimated', () => {
    const { View } = require('react-native');
    const anim = { duration: () => anim };
    return { __esModule: true, default: { View }, FadeIn: anim, FadeOut: anim, LinearTransition: {} };
});
jest.mock('@/components/custom/processing/use-processing-snapshot', () => ({ useProcessingSnapshot: () => ({}) }));
jest.mock('@/components/custom/processing/ChunkStrip', () => () => null);
jest.mock('@/lib/stores/selectors', () => ({}));
jest.mock('../FeedStatusDetails', () => () => null);
// jest's host views mock measureInWindow as a no-op that never calls back.
// The card and the layer are both measured; the layer sits 10pt down the
// window, so the dropdown must land in LAYER coordinates.
const ANCHOR = { x: 12, y: 195, width: 351, height: 64 };
const LAYER = { x: 0, y: 10, width: 375, height: 812 };
jest.mock('../stats-card-dropdown', () => {
    const actual = jest.requireActual('../stats-card-dropdown');
    return {
        ...actual,
        measureAnchor: (node: any, done: any) =>
            done(node?.props?.testID === 'dashboard-stats-dropdown-layer' ? LAYER : ANCHOR),
    };
});
jest.mock('@/lib/navigation/tab-bar', () => ({ useTabBarClearance: () => 83 }));
jest.mock('react-native-safe-area-context', () => ({
    useSafeAreaInsets: () => ({ top: 20, bottom: 49, left: 0, right: 0 }),
}));
let mockFocused = true;
jest.mock('@/lib/hooks/use-is-focused-safe', () => ({ useIsFocusedSafe: () => mockFocused }));

import DashboardStatsCardOnly from '../DashboardStatsCard';
import { StatusDropdownLayer, StatusDropdownProvider } from '../status-dropdown';

/** The card as ForYouScreen hosts it: provider around, layer last. */
const DashboardStatsCard = () => (
    <StatusDropdownProvider>
        <DashboardStatsCardOnly />
        <StatusDropdownLayer testIDPrefix="dashboard-stats" />
    </StatusDropdownProvider>
);

beforeEach(() => {
    mockArticleCount = 12;
    mockMode = 'idle';
    mockFocused = true;
    jest.useFakeTimers();
});
afterEach(() => jest.useRealTimers());

const HIDDEN = { includeHiddenElements: true } as const;
/** Every host testID inside the card itself (the dropdown lives outside it). */
const cardIds = (r: ReturnType<typeof render>) =>
    r
        .getByTestId('dashboard-stats-card', HIDDEN)
        .findAll((n: any) => typeof n.props?.testID === 'string' && typeof n.type === 'string')
        .map((n: any) => n.props.testID as string)
        // The chevron flips; that is a glyph, not a height change.
        .filter((id: string) => !id.startsWith('icon-'));

describe('DashboardStatsCard', () => {
    it('shows the article-count sentence, collapsed', () => {
        const r = render(<DashboardStatsCard />);
        expect(r.getByTestId('stats-sentence')).toBeTruthy();
        expect(r.queryByTestId('status-panel-idle', HIDDEN)).toBeNull();
    });

    it('opens the shared status body on tap', () => {
        const r = render(<DashboardStatsCard />);
        fireEvent.press(r.getByTestId('dashboard-stats-card-toggle'));
        expect(r.getByTestId('status-panel-idle', HIDDEN)).toBeTruthy();
    });

    it('auto-hides after the same delay as the Feed\'s panel (3000ms)', () => {
        const r = render(<DashboardStatsCard />);
        fireEvent.press(r.getByTestId('dashboard-stats-card-toggle'));
        act(() => {
            jest.advanceTimersByTime(2999);
        });
        expect(r.getByTestId('status-panel-idle', HIDDEN)).toBeTruthy();
        act(() => {
            jest.advanceTimersByTime(1);
        });
        expect(r.queryByTestId('status-panel-idle', HIDDEN)).toBeNull();
    });

    it('closes early on a second tap', () => {
        const r = render(<DashboardStatsCard />);
        fireEvent.press(r.getByTestId('dashboard-stats-card-toggle'));
        // The second tap lands on the backdrop, which covers the card.
        fireEvent.press(r.getByTestId('dashboard-stats-dropdown-backdrop', HIDDEN));
        expect(r.queryByTestId('status-panel-idle', HIDDEN)).toBeNull();
    });

    it('is still rendered at zero articles, showing the status line instead', () => {
        mockArticleCount = 0;
        mockMode = 'limited';
        const r = render(<DashboardStatsCard />);
        expect(r.queryByTestId('stats-sentence')).toBeNull();
        expect(r.getByTestId('dashboard-stats-card-state').props.children).toBe('feedStatus.modeLimited');
        fireEvent.press(r.getByTestId('dashboard-stats-card-toggle'));
        expect(r.getByTestId('status-panel-limited', HIDDEN)).toBeTruthy();
    });

    it('labels the toggle with the state first, then the action', () => {
        const r = render(<DashboardStatsCard />);
        const toggle = r.getByTestId('dashboard-stats-card-toggle');
        expect(toggle.props.accessibilityLabel).toBe('feedStatus.idle. feedStatus.openA11y');
    });

    it('announces entering the capped state, which the removed header mark used to do', () => {
        const { AccessibilityInfo } = require('react-native');
        const announce = jest.spyOn(AccessibilityInfo, 'announceForAccessibility').mockImplementation(() => {});
        try {
            const r = render(<DashboardStatsCard />);
            mockMode = 'limited';
            r.rerender(<DashboardStatsCard />);
            expect(announce).toHaveBeenCalledWith('feedStatus.modeLimited');
        } finally {
            announce.mockRestore();
        }
    });

    it('drops the panel in the screen layer, outside the card and NOT in a Modal, so the list never changes height', () => {
        const r = render(<DashboardStatsCard />);
        const before = cardIds(r);
        fireEvent.press(r.getByTestId('dashboard-stats-card-toggle'));
        const panel = r.getByTestId('status-panel-idle', HIDDEN);
        let inModal = false;
        let inCard = false;
        let inLayer = false;
        for (let p: any = panel.parent; p; p = p.parent) {
            if (p.type === 'Modal' || p.type?.displayName === 'Modal' || p.type?.name === 'Modal') inModal = true;
            if (p.props?.testID === 'dashboard-stats-card') inCard = true;
            if (p.props?.testID === 'dashboard-stats-dropdown-layer') inLayer = true;
        }
        // A Modal is its own window and covered the tab bar (captured).
        expect(inModal).toBe(false);
        expect(inLayer).toBe(true);
        expect(inCard).toBe(false);
        expect(r.queryByTestId('rn-modal', HIDDEN)).toBeNull();
        expect(cardIds(r)).toEqual(before);
    });

    it('lets touches through the layer and hides it from accessibility while closed', () => {
        const r = render(<DashboardStatsCard />);
        const layer = r.getByTestId('dashboard-stats-dropdown-layer', HIDDEN);
        expect(layer.props.pointerEvents).toBe('none');
        expect(layer.props.accessibilityElementsHidden).toBe(true);
        expect(layer.props.importantForAccessibility).toBe('no-hide-descendants');
    });

    it('anchors the dropdown directly under the card, within the tab bar', () => {
        const { StyleSheet } = require('react-native');
        const r = render(<DashboardStatsCard />);
        fireEvent.press(r.getByTestId('dashboard-stats-card-toggle'));
        const frame = StyleSheet.flatten(r.getByTestId('dashboard-stats-dropdown', HIDDEN).props.style);
        // Window y 195 + 64, less the layer's own window y of 10.
        expect(frame).toMatchObject({ position: 'absolute', top: 249, left: 12, width: 351 });
        const scroll = StyleSheet.flatten(r.getByTestId('dashboard-stats-dropdown-scroll', HIDDEN).props.style);
        expect(scroll.maxHeight).toBeGreaterThan(0);
    });

    it('has an invisible backdrop: a popover, no dimming', () => {
        const { StyleSheet } = require('react-native');
        const r = render(<DashboardStatsCard />);
        fireEvent.press(r.getByTestId('dashboard-stats-card-toggle'));
        const style = StyleSheet.flatten(r.getByTestId('dashboard-stats-dropdown-backdrop', HIDDEN).props.style) ?? {};
        expect(style.backgroundColor ?? 'transparent').toBe('transparent');
    });

    // Captured (C3): from the Dashboard mark the panel covers the stats card,
    // so the card could not close it. A tap on the open panel itself closes.
    it('closes on a tap anywhere on the open panel', () => {
        const r = render(<DashboardStatsCard />);
        fireEvent.press(r.getByTestId('dashboard-stats-card-toggle'));
        fireEvent.press(r.getByTestId('dashboard-stats-dropdown-panel', HIDDEN));
        expect(r.queryByTestId('status-panel-idle', HIDDEN)).toBeNull();
    });

    it('does not let the panel-wide close swallow VoiceOver: it is not an accessibility element', () => {
        const r = render(<DashboardStatsCard />);
        fireEvent.press(r.getByTestId('dashboard-stats-card-toggle'));
        expect(r.getByTestId('dashboard-stats-dropdown-panel', HIDDEN).props.accessible).toBe(false);
    });

    it('closes before "Manage plan" navigates, so no backdrop is stranded', () => {
        const r = render(<DashboardStatsCard />);
        fireEvent.press(r.getByTestId('dashboard-stats-card-toggle'));
        fireEvent.press(r.getByTestId('panel-manage-plan', HIDDEN));
        expect(r.queryByTestId('status-panel-idle', HIDDEN)).toBeNull();
    });

    it('closes when the tab loses focus: a Modal outlives a tab switch', () => {
        const r = render(<DashboardStatsCard />);
        fireEvent.press(r.getByTestId('dashboard-stats-card-toggle'));
        expect(r.getByTestId('status-panel-idle', HIDDEN)).toBeTruthy();
        mockFocused = false;
        r.rerender(<DashboardStatsCard />);
        expect(r.queryByTestId('status-panel-idle', HIDDEN)).toBeNull();
    });
});
