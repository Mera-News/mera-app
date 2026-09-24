/* eslint-disable @typescript-eslint/no-require-imports */
// Owner: "?" beside the title, the Mera mark right-most, and the "what Mera is
// doing" line INLINE between them, never on a row of its own.
import { render } from '@testing-library/react-native';
import React from 'react';

jest.mock('react-native-css-interop/jsx-runtime', () => {
    const R = require('react/jsx-runtime');
    return { jsx: R.jsx, jsxs: R.jsxs, Fragment: R.Fragment };
});
jest.mock('react-native-css-interop/jsx-dev-runtime', () => {
    const R = require('react/jsx-dev-runtime');
    return { jsxDEV: R.jsxDEV, Fragment: R.Fragment };
});
jest.mock('@/components/ui/hstack', () => {
    const { View } = require('react-native');
    return { HStack: (p: any) => <View {...p} /> };
});
jest.mock('@/components/custom/for-you/HeaderNarrationLine', () => {
    const { Text } = require('react-native');
    return {
        __esModule: true,
        default: (p: any) => (
            <Text testID={p.testID} numberOfLines={p.maxLines} align={p.align}>
                narration
            </Text>
        ),
    };
});

import { Text, View } from 'react-native';
import FeedHeaderTitleRow, { feedMarkMode } from '../FeedHeaderTitleRow';

const row = (narrating: boolean) =>
    render(
        <FeedHeaderTitleRow
            height={54}
            title={<Text testID="title">Feed</Text>}
            mark={<View testID="mark" />}
            explainer={<View testID="explainer" />}
            narrating={narrating}
            stage={null}
            onDevice={false}
        />,
    );

const order = (r: ReturnType<typeof row>) =>
    r.UNSAFE_root.findAll((n: any) => typeof n.props?.testID === 'string' && typeof n.type === 'string').map(
        (n: any) => n.props.testID,
    );

describe('FeedHeaderTitleRow', () => {
    it('orders the row title, "?", narration, mark, with the narration on one line', () => {
        const r = row(true);
        const ids = order(r);
        expect(ids.indexOf('title')).toBeLessThan(ids.indexOf('explainer'));
        expect(ids.indexOf('explainer')).toBeLessThan(ids.indexOf('feed-narration-line'));
        expect(ids.indexOf('feed-narration-line')).toBeLessThan(ids.indexOf('mark'));
        // The mark is the row's LAST child: the right-most spot.
        expect(ids[ids.length - 1]).toBe('mark');
        expect(r.getByTestId('feed-narration-line').props.numberOfLines).toBe(1);
        const inRow = (n: any): boolean => {
            for (let p = n; p; p = p.parent) if (p.props?.testID === 'feed-header-title-row') return true;
            return false;
        };
        expect(inRow(r.getByTestId('feed-narration-line'))).toBe(true);
    });

    it('centres the narration in the slot between the "?" and the mark (owner)', () => {
        const { StyleSheet } = require('react-native');
        const r = row(true);
        const slot = StyleSheet.flatten(r.getByTestId('feed-header-narration').props.style);
        // The slot is the whole gap: it grows to fill it and may shrink to 0.
        expect(slot.flex).toBe(1);
        expect(slot.minWidth).toBe(0);
        expect(slot.alignItems).toBe('center');
        const ids = order(r);
        expect(ids.indexOf('explainer')).toBeLessThan(ids.indexOf('feed-header-narration'));
        expect(ids.indexOf('feed-header-narration')).toBeLessThan(ids.indexOf('mark'));
        // The line itself centres, one line, same ellipsis clamp.
        const line = r.getByTestId('feed-narration-line');
        expect(line.props.numberOfLines).toBe(1);
        expect(line.props.align).toBe('center');
    });

    it('keeps the row the same height with and without a sync', () => {
        const { StyleSheet } = require('react-native');
        const idle = row(false);
        const idleH = StyleSheet.flatten(idle.getByTestId('feed-header-title-row').props.style).height;
        expect(idle.queryByTestId('feed-narration-line')).toBeNull();
        idle.unmount();
        const busy = row(true);
        // Same height whether or not the narration is drawn.
        expect(StyleSheet.flatten(busy.getByTestId('feed-header-title-row').props.style).height).toBe(idleH);
    });
});

// Owner: the mark is always there; it grows and draws only while Mera is
// really working. `statusMode` alone is 'processing' on every five-minute poll
// that finds nothing, which must not grow the mark.
describe('feedMarkMode', () => {
    it('is processing only while a sync really narrates', () => {
        expect(feedMarkMode(true, 'processing')).toBe('processing');
    });
    it('rests on a bare scheduler poll', () => {
        expect(feedMarkMode(false, 'processing')).toBe('idle');
    });
    it('keeps every other state, error and limited included, so their ink still shows', () => {
        expect(feedMarkMode(false, 'error')).toBe('error');
        expect(feedMarkMode(false, 'limited')).toBe('limited');
        expect(feedMarkMode(false, 'idle')).toBe('idle');
        expect(feedMarkMode(false, 'deferred')).toBe('deferred');
    });
});

// Owner ("still during wait"): while a cloud batch only waits on the server,
// the narration keeps showing but the mark stays small and still. The Feed
// passes `useIsFeedProcessing` to the row and `useIsFeedWorkingLocally` to
// `feedMarkMode`, so the two can disagree in exactly this state.
describe('server-wait: narration on, mark still', () => {
    it('narrates while the mark rests', () => {
        const r = row(true);
        expect(r.getByTestId('feed-narration-line')).toBeTruthy();
        // workingLocally false, statusMode 'processing' (the wait is still
        // `isFeedProcessing`): the mark draws its resting mode.
        expect(feedMarkMode(false, 'processing')).toBe('idle');
    });
});
