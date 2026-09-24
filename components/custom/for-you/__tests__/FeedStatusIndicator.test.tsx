/* eslint-disable @typescript-eslint/no-require-imports */
// The status mark — one slot, five states, and it is NEVER absent.
//
// The thing worth pinning here is that last clause. This component used to
// return null for `idle` and `deferred`, which meant the header changed shape at
// the end of every single sync and the detail panel behind the mark could only
// be opened while one happened to be running. Both regressions look like nothing
// in a screenshot, so `idle` and `deferred` get explicit "renders AND is
// tappable" tests rather than being treated as the boring cases.
//
// The rest is the state→appearance table, which is entirely carried by props
// handed to MeraLogo (colour, `animated`) plus the wrapper's scale. Mocking
// MeraLogo keeps react-native-svg out of this suite and turns that table into
// direct prop assertions.

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
    useTranslation: () => ({ t: (key: string) => key }),
}));

jest.mock('@/components/ui/pressable', () => {
    const { Pressable: RNPressable } = require('react-native');
    return { Pressable: RNPressable };
});
let mockLogoMounts = 0;
jest.mock('@/components/custom/MeraLogo', () => {
    const { View } = require('react-native');
    const ReactLib = require('react');
    return {
        __esModule: true,
        default: (p: any) => {
            // Counts MOUNTS, not renders: a remount is what the capture saw.
            ReactLib.useEffect(() => {
                mockLogoMounts += 1;
            }, []);
            return <View testID="mera-logo" {...p} />;
        },
    };
});
// `useAnimatedStyle` runs its worklet at render time here, so the style the
// wrapper receives is whatever the shared value holds on THAT render — which is
// the seed the component derived from `mode`. That is what makes the scale
// assertions below meaningful; they pin the resting size per mode, not the
// withTiming transition between two of them.
jest.mock('react-native-reanimated', () => {
    const { View } = require('react-native');
    return {
        __esModule: true,
        default: { View: (p: any) => <View {...p} /> },
        useSharedValue: (initial: unknown) => ({ value: initial }),
        useAnimatedStyle: (fn: () => unknown) => fn(),
        withTiming: (v: unknown, cfg?: unknown) => {
            mockWithTiming(v, cfg);
            return v;
        },
        useReducedMotion: () => mockReduceMotion,
    };
});
let mockReduceMotion = false;
const mockWithTiming = jest.fn();

let mockWindowWidth = 375;
jest.mock('react-native/Libraries/Utilities/useWindowDimensions', () => ({
    __esModule: true,
    default: () => ({ width: mockWindowWidth, height: 812, scale: 3, fontScale: 1 }),
}));

import FeedStatusIndicator from '../FeedStatusIndicator';

const OPEN_A11Y = 'feedStatus.openA11y';
const COLLAPSE_A11Y = 'feedStatus.collapseA11y';
const TEST_ID = 'feed-status-indicator';
const MARK_ID = `${TEST_ID}-mark`;

const ACTIVE = '#FFFFFF';
/** tailwind.config.js `light`. */
const RESTING = '#FBFBFB';

function renderIndicator(overrides: Partial<React.ComponentProps<typeof FeedStatusIndicator>> = {}) {
    return render(
        <FeedStatusIndicator
            mode="processing"
            expanded={false}
            onPress={jest.fn()}
            testID={TEST_ID}
            {...overrides}
        />,
    );
}

/** The scale factor the wrapper is actually carrying, flattened out of whatever
 *  shape the transform array arrived in. */
function scaleOf(node: any): number | undefined {
    const transform = node?.props?.style?.transform;
    return transform?.find((e: any) => 'scale' in e)?.scale;
}

const IDLE_SCALE = 1;
const PROCESSING_SCALE = 1.55;

describe('FeedStatusIndicator', () => {
    beforeEach(() => {
        mockReduceMotion = false;
    });

    // Owner: small and still at idle; bigger than before while processing,
    // with the torch sweeping over cards scrolling right to left.
    it('sweeps the torch over scrolling cards, enlarged past the old 1.3 and pure white, while processing', () => {
        const { getByTestId } = renderIndicator({ mode: 'processing' });
        expect(getByTestId('mera-logo').props.animated).toBe(true);
        expect(getByTestId('mera-logo').props.scrollCards).toBe(true);
        expect(getByTestId('mera-logo').props.color).toBe(ACTIVE);
        expect(scaleOf(getByTestId(MARK_ID))).toBe(PROCESSING_SCALE);
        expect(PROCESSING_SCALE).toBeGreaterThan(1.3);
    });

    it('under Reduce Motion: the processing size, but no torch and no cards', () => {
        mockReduceMotion = true;
        const { getByTestId } = renderIndicator({ mode: 'processing' });
        expect(getByTestId('mera-logo').props.animated).toBe(false);
        expect(getByTestId('mera-logo').props.scrollCards).toBe(false);
        expect(scaleOf(getByTestId(MARK_ID))).toBe(PROCESSING_SCALE);
    });

    it('renders a red mark on a scoring error', () => {
        const { getByTestId } = renderIndicator({ mode: 'error' });
        expect(getByTestId('mera-logo').props.color).toBe('#F87171');
        expect(getByTestId('mera-logo').props.animated ?? false).toBe(false);
        expect(getByTestId('mera-logo').props.scrollCards).toBe(false);
        expect(scaleOf(getByTestId(MARK_ID))).toBe(IDLE_SCALE);
    });

    it('renders an amber mark when daily-limited', () => {
        const { getByTestId } = renderIndicator({ mode: 'limited' });
        expect(getByTestId('mera-logo').props.color).toBe('#FBBF24');
        expect(getByTestId('mera-logo').props.animated ?? false).toBe(false);
        expect(getByTestId('mera-logo').props.scrollCards).toBe(false);
        expect(scaleOf(getByTestId(MARK_ID))).toBe(IDLE_SCALE);
    });

    it('still renders a still, off-white, tappable mark when idle', () => {
        // The whole point of the change: this used to return null, so the panel
        // was unreachable on the screen state the user spends most of their time
        // in and the header visibly resized every time a sync ended.
        const onPress = jest.fn();
        const { getByTestId } = renderIndicator({ mode: 'idle', onPress });
        expect(getByTestId('mera-logo').props.color).toBe(RESTING);
        expect(getByTestId('mera-logo').props.animated ?? false).toBe(false);
        expect(getByTestId('mera-logo').props.scrollCards).toBe(false);
        expect(scaleOf(getByTestId(MARK_ID))).toBe(IDLE_SCALE);

        fireEvent.press(getByTestId(TEST_ID));
        expect(onPress).toHaveBeenCalledTimes(1);
    });

    it('still renders a still, off-white, tappable mark when rows are merely deferred', () => {
        // `deferred` gets no colour or motion of its own: "waiting for the next
        // batch (N)" is a pipeline count the reader cannot act on, and giving it
        // a distinct look would put the deleted status bar's chatter back. It is
        // still reachable, because the count lives inside the panel this opens.
        const onPress = jest.fn();
        const { getByTestId } = renderIndicator({ mode: 'deferred', onPress });
        expect(getByTestId('mera-logo').props.color).toBe(RESTING);
        expect(getByTestId('mera-logo').props.animated ?? false).toBe(false);
        expect(getByTestId('mera-logo').props.scrollCards).toBe(false);
        expect(scaleOf(getByTestId(MARK_ID))).toBe(IDLE_SCALE);

        fireEvent.press(getByTestId(TEST_ID));
        expect(onPress).toHaveBeenCalledTimes(1);
    });

    it('animates in processing and in no other state', () => {
        // One assertion over the whole enum, so a new mode cannot quietly start
        // re-rasterising an SVG on the CPU behind a header that is at rest.
        const modes = ['processing', 'error', 'limited', 'deferred', 'idle'] as const;
        const on = (prop: string) =>
            modes.filter((mode) => renderIndicator({ mode }).getByTestId('mera-logo').props[prop] === true);
        expect(on('scrollCards')).toEqual(['processing']);
        expect(on('animated')).toEqual(['processing']);
    });

    it('calls onPress when tapped', () => {
        const onPress = jest.fn();
        const { getByTestId } = renderIndicator({ onPress });
        fireEvent.press(getByTestId(TEST_ID));
        expect(onPress).toHaveBeenCalledTimes(1);
    });

    it('advertises open vs collapse to screen readers', () => {
        // Substring match: the label now leads with the STATE and ends with the
        // action (see a11yStateKey). Matching the action alone is still the
        // right assertion for this test — the state half has its own below.
        const { queryByLabelText, rerender } = renderIndicator({ expanded: false });
        expect(queryByLabelText(new RegExp(OPEN_A11Y))).toBeTruthy();

        rerender(
            <FeedStatusIndicator mode="processing" expanded onPress={jest.fn()} testID={TEST_ID} />,
        );
        expect(queryByLabelText(new RegExp(COLLAPSE_A11Y))).toBeTruthy();
    });

    // The capped state used to be signalled by amber ink and NOTHING else, so a
    // screen-reader user was told "Open feed status" whether the feed was fine,
    // broken, or out of articles for the day. These two tests are the whole
    // reason the label is composed.
    it.each([
        ['processing', 'feedStatus.modeProcessing'],
        ['error', 'feedStatus.modeError'],
        ['limited', 'feedStatus.modeLimited'],
        ['idle', 'feedStatus.idle'],
        ['deferred', 'feedStatus.idle'],
    ] as const)('names the %s state in its accessibility label', (mode, key) => {
        const { queryByLabelText } = renderIndicator({ mode });
        expect(queryByLabelText(new RegExp(`^${key}\\.`))).toBeTruthy();
    });

    it('announces nothing itself: the screen owns the announcement (use-feed-mode-announcement)', () => {
        const { AccessibilityInfo } = require('react-native');
        const announce = jest
            .spyOn(AccessibilityInfo, 'announceForAccessibility')
            .mockImplementation(() => {});
        try {
            const { rerender, getByTestId } = renderIndicator({ mode: 'idle' });
            expect(getByTestId(TEST_ID)).toBeTruthy();
            rerender(
                <FeedStatusIndicator mode="limited" expanded={false} onPress={jest.fn()} testID={TEST_ID} />,
            );
            expect(announce).not.toHaveBeenCalled();
        } finally {
            announce.mockRestore();
        }
    });
});

// Captured: at a run's start the 18pt mark vanished in one frame and the big
// one drew from empty. The mark must be ONE instance that grows.
describe('FeedStatusIndicator: grows, never swaps', () => {
    it('keeps the same mark mounted from rest to processing and back', () => {
        mockLogoMounts = 0;
        const { rerender, getByTestId } = renderIndicator({ mode: 'idle' });
        const first = getByTestId('mera-logo');
        rerender(<FeedStatusIndicator mode="processing" expanded={false} onPress={jest.fn()} testID={TEST_ID} />);
        expect(getByTestId('mera-logo')).toBe(first);
        rerender(<FeedStatusIndicator mode="idle" expanded={false} onPress={jest.fn()} testID={TEST_ID} />);
        expect(mockLogoMounts).toBe(1);
    });

    it('animates the scale to 1.55 over 250ms', () => {
        mockWithTiming.mockClear();
        const { rerender } = renderIndicator({ mode: 'idle' });
        rerender(<FeedStatusIndicator mode="processing" expanded={false} onPress={jest.fn()} testID={TEST_ID} />);
        expect(mockWithTiming).toHaveBeenCalledWith(1.55, { duration: 250 });
    });
});

// Owner: "the animation should run only when feed is updating, otherwise it
// stays static", and "still during wait". The Feed feeds the mark
// `feedMarkMode(workingLocally, statusMode)`; this walks the chain end to end
// for every state in which the phone itself is not working.
describe('FeedStatusIndicator: static unless the Feed is really updating', () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { feedMarkMode } = require('@/components/custom/feed/FeedHeaderTitleRow');
    const still = (workingLocally: boolean, statusMode: string) => {
        const { getByTestId } = renderIndicator({ mode: feedMarkMode(workingLocally, statusMode) });
        const logo = getByTestId('mera-logo');
        return logo.props.animated === false && logo.props.scrollCards === false;
    };

    it('is still at rest', () => {
        expect(still(false, 'idle')).toBe(true);
        expect(still(false, 'deferred')).toBe(true);
    });

    it('is still in the error and limited states', () => {
        expect(still(false, 'error')).toBe(true);
        expect(still(false, 'limited')).toBe(true);
    });

    it('is still on a bare scheduler poll, while a batch only waits on the server, and after a sync fails partway', () => {
        // A poll, or a cloud batch waiting on the server: statusMode is
        // 'processing' but the phone is not working. A failed sync publishes state 'failed', which
        // neither flag counts, so the phone is not working; the mode is
        // then 'error' (scoring failure) or 'processing' (scheduler still
        // winding down), and neither may move the mark.
        expect(still(false, 'processing')).toBe(true);
        expect(still(false, 'error')).toBe(true);
    });

    it('moves only while the phone itself works', () => {
        expect(still(true, 'processing')).toBe(false);
    });
});

// Owner: "as big as the Feed text in the same line". The resting mark's
// layout size IS the measured ink height of "Feed" in the header title
// (CoreText, system bold: 21.5pt at 30px, 25.8pt at 36px), at scale 1, from
// the same breakpoint as the title; processing grows it 1.55x by transform.
describe('FeedStatusIndicator: sized to the Feed title', () => {
    afterEach(() => {
        mockWindowWidth = 375;
    });
    it('rests at the "Feed" ink height on a compact phone (375pt, 3xl title)', () => {
        mockWindowWidth = 375;
        const { getByTestId } = renderIndicator({ mode: 'idle' });
        expect(getByTestId('mera-logo').props.size).toBe(21.5);
        expect(scaleOf(getByTestId(MARK_ID))).toBe(1);
    });
    it('rests at the "Feed" ink height on a wide phone (402pt, 4xl title)', () => {
        mockWindowWidth = 402;
        const { getByTestId } = renderIndicator({ mode: 'idle' });
        expect(getByTestId('mera-logo').props.size).toBe(25.8);
    });
    it('grows 1.55x while working, by transform, so the layout box never changes', () => {
        const { getByTestId } = renderIndicator({ mode: 'processing' });
        expect(getByTestId('mera-logo').props.size).toBe(21.5);
        expect(scaleOf(getByTestId(MARK_ID))).toBe(1.55);
    });
});
