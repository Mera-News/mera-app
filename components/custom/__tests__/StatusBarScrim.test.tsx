/* eslint-disable @typescript-eslint/no-require-imports */
// F21: the dark over-content base behind the status bar appears ONLY while the
// collapsing header is hidden. Permanently, the translucent header would sample
// it at rest and darken its own top.
jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 62, bottom: 34, left: 0, right: 0 }),
}));
jest.mock('@/components/custom/GlassSurface', () => {
  const { View } = require('react-native');
  return {
    GLASS_HEADER_SCRIM: 'rgba(0,0,0,0.42)',
    GLASS_HEADER_TINT: 'rgba(255,255,255,0.16)',
    GLASS_OVER_CONTENT_FILL: 'rgba(18,17,19,0.90)',
    GlassHeaderAndroidBackdrop: () => null,
    GlassPlate: () => <View testID="glass-plate" />,
  };
});
jest.mock('react-native-reanimated', () => {
  const { View } = require('react-native');
  return {
    __esModule: true,
    default: { View: (p: any) => <View {...p} /> },
    // The animated style reads the shared value once, which is all a test needs.
    useAnimatedStyle: (fn: () => object) => fn(),
  };
});

import { render, screen } from '@testing-library/react-native';
import React from 'react';
import { StyleSheet } from 'react-native';
import StatusBarScrim from '../StatusBarScrim';

const opacityOf = (id: string) =>
  StyleSheet.flatten(screen.getByTestId(id, { includeHiddenElements: true }).props.style).opacity;

describe('StatusBarScrim', () => {
  it('without a collapsing header, keeps its original look and no dark base', () => {
    render(<StatusBarScrim />);
    expect(StyleSheet.flatten(screen.getByTestId('status-bar-scrim').props.style).backgroundColor).toBe(
      'rgba(0,0,0,0.42)',
    );
    expect(screen.queryByTestId('status-bar-scrim-cover', { includeHiddenElements: true })).toBeNull();
  });

  it('keeps the dark base invisible while the header is revealed', () => {
    render(<StatusBarScrim coverProgress={{ value: 0 } as any} />);
    expect(opacityOf('status-bar-scrim-cover')).toBe(0);
  });

  it('shows the dark base, and the fade below the strip, once the header is hidden', () => {
    render(<StatusBarScrim coverProgress={{ value: 1 } as any} />);
    expect(opacityOf('status-bar-scrim-cover')).toBe(1);
    const band = StyleSheet.flatten(
      screen.getByTestId('status-bar-scrim-fade-0', { includeHiddenElements: true }).props.style,
    );
    expect(band.top).toBe(62);
  });
});
