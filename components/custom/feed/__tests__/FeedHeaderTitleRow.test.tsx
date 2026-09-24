/* eslint-disable @typescript-eslint/no-require-imports */
// Owner: the Feed's "what Mera is doing" line lives INLINE in the title row,
// one line between the status mark and the "?", never on a row of its own.
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
import FeedHeaderTitleRow from '../FeedHeaderTitleRow';

const row = (narrating: boolean) =>
    render(
        <FeedHeaderTitleRow
            height={54}
            title={<Text>Feed</Text>}
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
    it('puts the narration in the title row, between the mark and the "?", on one line', () => {
        const r = row(true);
        const ids = order(r);
        expect(ids.indexOf('mark')).toBeLessThan(ids.indexOf('feed-narration-line'));
        expect(ids.indexOf('feed-narration-line')).toBeLessThan(ids.indexOf('explainer'));
        expect(r.getByTestId('feed-narration-line').props.numberOfLines).toBe(1);
        const inRow = (n: any): boolean => {
            for (let p = n; p; p = p.parent) if (p.props?.testID === 'feed-header-title-row') return true;
            return false;
        };
        expect(inRow(r.getByTestId('feed-narration-line'))).toBe(true);
    });

    it('keeps the row the same height with and without a sync', () => {
        const { StyleSheet } = require('react-native');
        const idle = row(false);
        const idleH = StyleSheet.flatten(idle.getByTestId('feed-header-title-row').props.style).height;
        expect(idle.queryByTestId('feed-narration-line')).toBeNull();
        idle.unmount();
        const busy = row(true);
        expect(StyleSheet.flatten(busy.getByTestId('feed-header-title-row').props.style).height).toBe(idleH);
    });
});
