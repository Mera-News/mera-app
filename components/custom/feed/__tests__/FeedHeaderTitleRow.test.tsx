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
            <Text testID={p.testID} numberOfLines={p.maxLines}>
                narration
            </Text>
        ),
    };
});

import { Text, View } from 'react-native';
import FeedHeaderTitleRow, { feedMarkVisible } from '../FeedHeaderTitleRow';

const row = (narrating: boolean, withMark = true) =>
    render(
        <FeedHeaderTitleRow
            height={54}
            title={<Text testID="title">Feed</Text>}
            mark={withMark ? <View testID="mark" /> : null}
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

    it('pushes the narration against the mark', () => {
        const { StyleSheet } = require('react-native');
        const r = row(true);
        expect(StyleSheet.flatten(r.getByTestId('feed-header-narration').props.style).alignItems).toBe('flex-end');
    });

    it('draws no mark when the screen passes none, and keeps the "?"', () => {
        const r = row(false, false);
        expect(r.getByTestId('explainer')).toBeTruthy();
        expect(r.queryByTestId('mark')).toBeNull();
    });

    it('keeps the row the same height with and without a sync', () => {
        const { StyleSheet } = require('react-native');
        const idle = row(false, false);
        const idleH = StyleSheet.flatten(idle.getByTestId('feed-header-title-row').props.style).height;
        expect(idle.queryByTestId('feed-narration-line')).toBeNull();
        idle.unmount();
        const busy = row(true, true);
        // Same height whether or not the mark and the narration are drawn.
        expect(StyleSheet.flatten(busy.getByTestId('feed-header-title-row').props.style).height).toBe(idleH);
    });
});

describe('feedMarkVisible', () => {
    it('shows the mark while a sync narrates', () => {
        expect(feedMarkVisible(true, 'processing')).toBe(true);
    });
    it('keeps it in the capped and error states, which only its ink announces', () => {
        expect(feedMarkVisible(false, 'limited')).toBe(true);
        expect(feedMarkVisible(false, 'error')).toBe(true);
    });
    it('hides it at idle, deferred, and on a bare scheduler poll', () => {
        expect(feedMarkVisible(false, 'idle')).toBe(false);
        expect(feedMarkVisible(false, 'deferred')).toBe(false);
        expect(feedMarkVisible(false, 'processing')).toBe(false);
    });
});
