/* eslint-disable @typescript-eslint/no-require-imports */
// A2: the detail note names the profile fact the story matched, and the chip
// opens that fact's story list.
import { fireEvent, render, waitFor } from '@testing-library/react-native';
import React from 'react';

jest.mock('react-native-css-interop/jsx-runtime', () => {
    const R = require('react/jsx-runtime');
    return { jsx: R.jsx, jsxs: R.jsxs, Fragment: R.Fragment };
});
jest.mock('react-native-css-interop/jsx-dev-runtime', () => {
    const R = require('react/jsx-dev-runtime');
    return { jsxDEV: R.jsxDEV, Fragment: R.Fragment };
});
jest.mock('react-i18next', () => ({
    useTranslation: () => ({
        t: (k: string, o?: Record<string, string>) => (o?.label ? `${k}:${o.label}` : k),
    }),
}));
const mockPush = jest.fn();
jest.mock('expo-router', () => ({ router: { push: (...a: any[]) => mockPush(...a) } }));
jest.mock('@/components/custom/ArticleMetaRow', () => ({ ArticleMetaRow: () => null }));
jest.mock('@/components/custom/news-detail/ExtractedMetadataPanel', () => ({ __esModule: true, default: () => null }));
jest.mock('@/components/custom/GlassSurface', () => ({ GlassPanel: () => null }));
jest.mock('@/components/custom/MeraLogo', () => ({ __esModule: true, default: () => null }));
jest.mock('@/components/custom/TranslatableDynamic', () => ({ __esModule: true, default: () => null }));
jest.mock('@/components/custom/cards/ReasonNote', () => ({
    __esModule: true,
    default: ({ below }: any) => below ?? null,
}));
let mockFacts: any[] = [];
jest.mock('@/lib/database/services/fact-service', () => ({
    getFactsForTopicTexts: jest.fn(async () => mockFacts),
}));
jest.mock('@/components/custom/SmoothScrollView', () => {
    const ReactLib = require('react');
    const { View } = require('react-native');
    return {
        __esModule: true,
        default: ReactLib.forwardRef(({ children }: any, _ref: any) => ReactLib.createElement(View, null, children)),
    };
});
jest.mock('@/lib/stores/blur-images-store', () => ({
    useBlurImagesStore: (sel: (s: { blurImages: boolean }) => unknown) => sel({ blurImages: false }),
}));

import { ArticleSuggestionStatus } from '@/lib/database/article-suggestion-status';
import { ArticleSuggestionContainer } from '../ArticleSuggestionContainer';

let n = 0;
const suggestion = (topics: string[]) =>
    ({
        _id: `s${++n}`,
        articleId: `a${n}`,
        title_en: 'T',
        status: ArticleSuggestionStatus.Complete,
        relevance: 0.7,
        reason: 'Because you live in Berlin.',
        // A fresh topic set per test, so the module-level facts cache never
        // answers from a previous test.
        userTopicIds: topics.map((x) => `${x}-${n}`),
    }) as any;

describe('detail fact chip (A2)', () => {
    beforeEach(() => mockPush.mockClear());

    it('names the matched fact under the note and opens its story list', async () => {
        mockFacts = [{ id: 'f1', statement: 'I live in Berlin' }];
        const { findByTestId } = render(
            <ArticleSuggestionContainer suggestion={suggestion(['berlin'])} variant="screen" />,
        );
        const chip = await findByTestId('detail-fact-chip');
        expect(chip.props.accessibilityLabel).toBe('factChip.openA11y:I live in Berlin');
        fireEvent.press(chip);
        expect(mockPush).toHaveBeenCalledWith({
            pathname: '/logged-in/fact-feed',
            params: { factId: 'f1', statement: 'I live in Berlin' },
        });
    });

    it('shows no chip when the fact is gone', async () => {
        mockFacts = [];
        const { queryByTestId } = render(
            <ArticleSuggestionContainer suggestion={suggestion(['gone'])} variant="screen" />,
        );
        const { getFactsForTopicTexts } = require('@/lib/database/services/fact-service');
        await waitFor(() => expect(getFactsForTopicTexts).toHaveBeenCalled());
        expect(queryByTestId('detail-fact-chip')).toBeNull();
    });
});
