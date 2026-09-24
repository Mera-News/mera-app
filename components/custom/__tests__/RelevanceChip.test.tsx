/* eslint-disable @typescript-eslint/no-require-imports */
// Owner review: the priority badge is its word alone ("High", "Med", "Low"),
// with no leading arrow or dash glyph, on every surface that renders it.
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
jest.mock('react-i18next', () => ({ useTranslation: () => ({ t: (k: string) => k }) }));
jest.mock('@expo/vector-icons', () => {
    const { View } = require('react-native');
    return { MaterialIcons: (p: any) => <View testID={`icon-${p.name}`} /> };
});

import { bandOf } from '@/lib/news-harness/feed-select/ownership';
import { getRelevanceColors } from '@/lib/relevance-utils';
import RelevanceChip from '../RelevanceChip';

// One representative score per band, found from the band source itself so the
// test never hardcodes the cutoffs.
function scoreFor(band: string): number {
    for (let r = 1; r >= 0; r -= 0.01) if (bandOf(r) === band) return r;
    throw new Error(`no score for ${band}`);
}

describe('RelevanceChip', () => {
    it.each(['HIGH', 'MEDIUM', 'LOW'])('%s: the word alone, no arrow or dash glyph', (band) => {
        const r = scoreFor(band);
        const { queryByTestId, getByText } = render(<RelevanceChip relevance={r} />);
        for (const g of ['arrow-upward', 'arrow-downward', 'remove']) {
            expect(queryByTestId(`icon-${g}`)).toBeNull();
        }
        expect(getByText(getRelevanceColors(r).label)).toBeTruthy();
    });

    it('keeps the band colours', () => {
        const r = scoreFor('HIGH');
        const { getByText } = render(<RelevanceChip relevance={r} />);
        const { StyleSheet } = require('react-native');
        expect(StyleSheet.flatten(getByText(getRelevanceColors(r).label).props.style).color).toBe(
            getRelevanceColors(r).textColor,
        );
    });
});
