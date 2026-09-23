/* eslint-disable @typescript-eslint/no-require-imports */
jest.mock('react-native-safe-area-context', () => ({
    useSafeAreaInsets: () => ({ top: 0, bottom: 34, left: 0, right: 0 }),
}));
jest.mock('@/components/custom/GlassSurface', () => {
    const { View } = require('react-native');
    return {
        GLASS_OVER_CONTENT_FILL: 'rgba(18,17,19,0.90)',
        GlassPlate: (p: any) => <View {...p} testID="glass-plate" />,
    };
});
jest.mock('react-native-reanimated', () => {
    const { Pressable } = require('react-native');
    return {
        __esModule: true,
        default: { createAnimatedComponent: () => Pressable },
        FadeIn: { duration: () => undefined },
        FadeOut: { duration: () => undefined },
    };
});

import { render, screen } from '@testing-library/react-native';
import React from 'react';
import { StyleSheet } from 'react-native';
import ScrollToTopFab from '../ScrollToTopFab';

const bottomOf = () =>
    StyleSheet.flatten(screen.getByTestId('feed-scroll-top-fab').props.style).bottom;

describe('ScrollToTopFab', () => {
    it('always paints a solid base under the glass, so it can never be a bare arrow', () => {
        render(<ScrollToTopFab visible onPress={jest.fn()} />);
        const base = StyleSheet.flatten(
            screen.getByTestId('feed-scroll-top-fab-base', { includeHiddenElements: true }).props
                .style,
        );
        expect(base.backgroundColor).toBe('rgba(18,17,19,0.90)');
        expect(base.borderRadius).toBe(25);
    });

    it('renders nothing while hidden', () => {
        render(<ScrollToTopFab visible={false} onPress={jest.fn()} />);
        expect(screen.queryByTestId('feed-scroll-top-fab')).toBeNull();
    });

    it('takes a whole bottom inset from an in-tab host instead of inset plus offset', () => {
        render(<ScrollToTopFab visible onPress={jest.fn()} bottomInset={85} extraBottomOffset={49} />);
        expect(bottomOf()).toBe(20 + 85);
    });

    it('keeps the old inset plus offset arithmetic for existing callers', () => {
        render(<ScrollToTopFab visible onPress={jest.fn()} extraBottomOffset={10} />);
        expect(bottomOf()).toBe(20 + 34 + 10);
    });
});
