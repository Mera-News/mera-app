/**
 * The one BottomSheet's geometry (Sheet board): edge to edge, top corners only, a top hairline,
 * 20pt content sides, the safe-area bottom plus 8, a 40x5 handle. Mocked: the RN Modal native
 * spec, Reanimated's reduced-motion read and the safe-area insets (a home-indicator phone).
 */
import React from 'react';
import { StyleSheet, Text } from 'react-native';
import { render, screen } from '@testing-library/react-native';
import { BottomSheet } from '@/components/ui/bottom-sheet';
import { initI18nEn } from '@/test/helpers';

jest.mock('react-native/Libraries/Modal/Modal', () => {
    const { View } = jest.requireActual('react-native');
    return {
        __esModule: true,
        default: ({ visible, children }: { visible?: boolean; children?: React.ReactNode }) =>
            visible ? <View>{children}</View> : null,
    };
});
jest.mock('react-native-reanimated', () => {
    const actual = jest.requireActual('react-native-reanimated');
    return { ...actual, __esModule: true, default: actual.default ?? actual, useReducedMotion: () => true };
});
// The sheet pads for the WINDOW's bottom inset (initialWindowMetrics), not the mounting screen's.
jest.mock('react-native-safe-area-context', () => ({
    ...jest.requireActual('react-native-safe-area-context/jest/mock').default,
    useSafeAreaInsets: () => ({ top: 47, bottom: 34, left: 0, right: 0 }),
    initialWindowMetrics: { insets: { top: 47, bottom: 34, left: 0, right: 0 }, frame: { x: 0, y: 0, width: 390, height: 844 } },
}));

beforeAll(initI18nEn);

const styleOf = (id: string) => StyleSheet.flatten(screen.getByTestId(id).props.style);

function sheet(fullHeight?: boolean) {
    render(
        <BottomSheet open onClose={() => {}} testID="s" fullHeight={fullHeight}>
            <Text>Body</Text>
        </BottomSheet>,
    );
}

it('spans the screen with no side or bottom inset', () => {
    sheet();
    const outer = styleOf('s');
    expect(outer.marginHorizontal ?? 0).toBe(0);
    expect(outer.marginBottom ?? 0).toBe(0);
    expect(outer.marginLeft ?? 0).toBe(0);
    expect(outer.marginRight ?? 0).toBe(0);
});

it('rounds the top corners only, with a 1pt top hairline', () => {
    sheet();
    const surface = styleOf('s-surface');
    expect(surface).toMatchObject({ borderTopLeftRadius: 24, borderTopRightRadius: 24, borderTopWidth: 1, overflow: 'hidden' });
    expect(surface.borderRadius).toBeUndefined();
    expect(surface.borderBottomLeftRadius ?? 0).toBe(0);
    expect(surface.borderBottomRightRadius ?? 0).toBe(0);
    expect(surface.borderWidth).toBeUndefined();
});

it('pads content 20 at the sides and the safe-area bottom plus 8', () => {
    sheet();
    expect(styleOf('s-content')).toMatchObject({ paddingHorizontal: 20, paddingBottom: 42 });
    expect(styleOf('s-handle')).toMatchObject({ width: 40, height: 5 });
});

it('a full-height sheet gives its content the full width', () => {
    sheet(true);
    expect(styleOf('s-content').paddingHorizontal).toBeUndefined();
    expect(styleOf('s-content').paddingBottom).toBe(42);
});
