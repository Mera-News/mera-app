/* eslint-disable @typescript-eslint/no-require-imports */
// M7/M8/F31: the hero starts at the top, and the detail top bar turns solid
// exactly when the meta row scrolls under it.
import { act, render } from '@testing-library/react-native';
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
jest.mock('react-native-safe-area-context', () => ({
    useSafeAreaInsets: () => ({ top: 59, bottom: 34, left: 0, right: 0 }),
}));
jest.mock('@/components/custom/ArticleMetaRow', () => ({ ArticleMetaRow: () => null }));
jest.mock('@/components/custom/news-detail/ExtractedMetadataPanel', () => ({ __esModule: true, default: () => null }));
jest.mock('@/components/custom/GlassSurface', () => ({
    GlassPanel: () => null,
    TranslucentPlate: () => null,
    GLASS_OVER_CONTENT_FILL: '#111',
}));
jest.mock('@/components/custom/MeraLogo', () => ({ __esModule: true, default: () => null }));
jest.mock('@/components/custom/TranslatableDynamic', () => ({ __esModule: true, default: () => null }));
jest.mock('@/components/custom/cards/ReasonNote', () => ({ __esModule: true, default: () => null }));
jest.mock('@/lib/database/services/fact-service', () => ({ getFactsForTopicTexts: jest.fn(async () => []) }));
let mockScroll: ((y: number) => void) | null = null;
jest.mock('@/components/custom/SmoothScrollView', () => {
    const ReactLib = require('react');
    const { View } = require('react-native');
    return {
        __esModule: true,
        default: ReactLib.forwardRef(
            ({ parallaxHeader, children, onScrollPositionChange, contentContainerStyle }: any, _ref: any) => {
                mockScroll = onScrollPositionChange;
                return ReactLib.createElement(
                    View,
                    { testID: 'detail-scroll', style: contentContainerStyle },
                    parallaxHeader,
                    children,
                );
            },
        ),
    };
});
jest.mock('@/components/ui/image', () => {
    const { View } = require('react-native');
    return { Image: (p: any) => <View {...p} /> };
});
jest.mock('@/lib/stores/blur-images-store', () => ({
    useBlurImagesStore: (sel: (s: { blurImages: boolean }) => unknown) => sel({ blurImages: false }),
}));

import { ArticleSuggestionContainer, SCREEN_HEADER_HEIGHT } from '../ArticleSuggestionContainer';
import DetailTopBar, { DETAIL_TOP_BAR_FADE_MS, DETAIL_TOP_BAR_HEIGHT } from '../news-detail/DetailTopBar';

const withImage = { _id: 'a1', title: 'T', image_url: 'https://x/img.jpg' } as any;
const noImage = { _id: 'a2', title: 'T' } as any;
const INSET = 59;

describe('detail hero (M7)', () => {
    it('starts the hero at the very top, under the status-bar scrim', () => {
        const { getByTestId } = render(
            <ArticleSuggestionContainer article={withImage} variant="screen" contentTopInset={INSET} />,
        );
        expect(getByTestId('detail-scroll').props.style.paddingTop).toBe(0);
    });

    it('keeps the inset when there is no hero', () => {
        const { getByTestId } = render(
            <ArticleSuggestionContainer article={noImage} variant="screen" contentTopInset={INSET} />,
        );
        expect(getByTestId('detail-scroll').props.style.paddingTop).toBe(INSET);
    });
});

describe('detail top bar turns solid on scroll (M8/F31)', () => {
    it('reports only the crossings, at the point the meta row reaches the bar', () => {
        const onSolid = jest.fn();
        render(
            <ArticleSuggestionContainer
                article={withImage}
                variant="screen"
                contentTopInset={INSET}
                onTopBarSolidChange={onSolid}
            />,
        );
        // Meta row top = hero + p-5; bar bottom = inset + bar height.
        const solidAfter = SCREEN_HEADER_HEIGHT + 20 - (INSET + DETAIL_TOP_BAR_HEIGHT);
        act(() => mockScroll!(0));
        act(() => mockScroll!(solidAfter));
        expect(onSolid).not.toHaveBeenCalled();
        act(() => mockScroll!(solidAfter + 1));
        act(() => mockScroll!(solidAfter + 50));
        expect(onSolid).toHaveBeenCalledTimes(1);
        expect(onSolid).toHaveBeenLastCalledWith(true);
        act(() => mockScroll!(0));
        expect(onSolid).toHaveBeenCalledTimes(2);
        expect(onSolid).toHaveBeenLastCalledWith(false);
    });

    it('with no hero, turns solid almost at once, since the meta row starts just under the button', () => {
        const onSolid = jest.fn();
        render(
            <ArticleSuggestionContainer
                article={noImage}
                variant="screen"
                contentTopInset={INSET}
                onTopBarSolidChange={onSolid}
            />,
        );
        act(() => mockScroll!(40));
        expect(onSolid).toHaveBeenCalledWith(true);
    });
});

describe('DetailTopBar plate', () => {
    const { StyleSheet } = require('react-native');
    const opacityOf = (node: any) => StyleSheet.flatten(node.props.style).opacity;

    it('is invisible until solid, then fades in', () => {
        const { Animated } = require('react-native');
        const timing = jest.spyOn(Animated, 'timing');
        const { getByTestId, rerender } = render(<DetailTopBar onBack={jest.fn()} />);
        expect(opacityOf(getByTestId('detail-top-plate', { includeHiddenElements: true }))).toBe(0);
        rerender(<DetailTopBar onBack={jest.fn()} solid />);
        // The native-driven fade never reaches JS props under jest; what is
        // pinned is the target and the duration it was asked for.
        expect(timing).toHaveBeenLastCalledWith(
            expect.anything(),
            expect.objectContaining({ toValue: 1, duration: DETAIL_TOP_BAR_FADE_MS }),
        );
        timing.mockRestore();
    });

    it('covers the status bar and the button, never catching taps', () => {
        const { getByTestId } = render(<DetailTopBar onBack={jest.fn()} solid />);
        const plate = getByTestId('detail-top-plate', { includeHiddenElements: true });
        expect(StyleSheet.flatten(plate.props.style).height).toBe(INSET + DETAIL_TOP_BAR_HEIGHT);
        expect(plate.props.pointerEvents).toBe('none');
    });
});
