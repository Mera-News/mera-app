/* eslint-disable @typescript-eslint/no-require-imports */
// N14: "Blur images" covers the detail hero too.
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
jest.mock('@/components/custom/ArticleMetaRow', () => ({ ArticleMetaRow: () => null }));
jest.mock('@/components/custom/news-detail/ExtractedMetadataPanel', () => ({ __esModule: true, default: () => null }));
jest.mock('@/components/custom/GlassSurface', () => ({ GlassPanel: () => null }));
jest.mock('@/components/custom/MeraLogo', () => ({ __esModule: true, default: () => null }));
jest.mock('@/components/custom/TranslatableDynamic', () => ({ __esModule: true, default: () => null }));
jest.mock('@/components/custom/cards/ReasonNote', () => ({ __esModule: true, default: () => null }));
jest.mock('@/lib/database/services/fact-service', () => ({ getFactsForTopicTexts: jest.fn(async () => []) }));
jest.mock('@/components/custom/SmoothScrollView', () => {
    const ReactLib = require('react');
    const { View } = require('react-native');
    return {
        __esModule: true,
        default: ReactLib.forwardRef(({ parallaxHeader, children }: any, _ref: any) =>
            ReactLib.createElement(View, null, parallaxHeader, children),
        ),
    };
});
jest.mock('@/components/ui/image', () => {
    const { View } = require('react-native');
    return { Image: (p: any) => <View {...p} /> };
});
let mockBlur = false;
jest.mock('@/lib/stores/blur-images-store', () => ({
    useBlurImagesStore: (sel: (s: { blurImages: boolean }) => unknown) => sel({ blurImages: mockBlur }),
}));

import { ArticleSuggestionContainer } from '../ArticleSuggestionContainer';

const article = { _id: 'a1', title: 'T', image_url: 'https://x/img.jpg' } as any;

describe('ArticleSuggestionContainer detail hero blur (N14)', () => {
    it('blurs the hero when "Blur images" is on', () => {
        mockBlur = true;
        const { getByTestId } = render(<ArticleSuggestionContainer article={article} variant="screen" />);
        expect(getByTestId('detail-hero-image').props.blurRadius).toBe(24);
    });

    it('leaves the hero sharp when it is off', () => {
        mockBlur = false;
        const { getByTestId } = render(<ArticleSuggestionContainer article={article} variant="screen" />);
        expect(getByTestId('detail-hero-image').props.blurRadius).toBeUndefined();
    });
});
