/* eslint-disable @typescript-eslint/no-require-imports */
// M7/M8/F31: the hero starts at the top, and the detail top bar turns solid
// exactly when the meta row scrolls under it.
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
jest.mock('react-native-reanimated', () => {
    const { View } = require('react-native');
    const ReactLib = require('react');
    return {
        __esModule: true,
        default: { View: (p: any) => <View {...p} /> },
        useAnimatedStyle: (fn: () => object) => fn(),
        useSharedValue: (v: number) => ReactLib.useRef({ value: v }).current,
        withTiming: (to: number, o: { duration: number }) => ({ to, duration: o.duration }),
    };
});
jest.mock('@/lib/stores/blur-images-store', () => ({
    useBlurImagesStore: (sel: (s: { blurImages: boolean }) => unknown) => sel({ blurImages: false }),
}));

import { ArticleSuggestionContainer } from '../ArticleSuggestionContainer';
import DetailTopBar from '../news-detail/DetailTopBar';

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

// Owner: "earlier in detail page i never saw this dark header. even when
// scrolled up. can we make it like that again". No dark band at any scroll
// position: content scrolls freely under the status area, and the back button
// floats over it on its own dark circle.
describe('no dark header on the detail screens', () => {
    const { StyleSheet } = require('react-native');

    it('DetailTopBar draws only the floating back button, never a plate behind it', () => {
        const r = render(<DetailTopBar onBack={jest.fn()} />);
        expect(r.queryByTestId('detail-top-plate', { includeHiddenElements: true })).toBeNull();
        const back = r.getByTestId('detail-back');
        // Its own dark circle keeps it legible over photos and text.
        expect(back.props.className).toEqual(expect.stringContaining('bg-gray-900'));
        expect(back.props.className).toEqual(expect.stringContaining('rounded-full'));
    });

    it('the scroll container hands scroll position straight to the host: no crossing logic', () => {
        const onScroll = jest.fn();
        render(<ArticleSuggestionContainer article={withImage} variant="screen" contentTopInset={INSET} onScrollPositionChange={onScroll} />);
        expect(mockScroll).toBe(onScroll);
    });

    it('the button sits at the safe-area top, above the content', () => {
        const r = render(<DetailTopBar onBack={jest.fn()} />);
        let frame: any = r.getByTestId('detail-back');
        while (frame && !(frame.props?.style && StyleSheet.flatten(frame.props.style)?.position === 'absolute')) frame = frame.parent;
        expect(StyleSheet.flatten(frame.props.style)).toEqual(expect.objectContaining({ top: INSET + 8, zIndex: 20 }));
    });
});
