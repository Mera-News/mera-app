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

  describe('overHero (detail screens)', () => {
    it('has no flat scrim, no glass and no cover at rest', () => {
      render(<StatusBarScrim overHero coverProgress={{ value: 0 } as any} />);
      const style = StyleSheet.flatten(screen.getByTestId('status-bar-scrim').props.style);
      expect(style.backgroundColor).toBeUndefined();
      expect(screen.queryByTestId('glass-plate')).toBeNull();
      expect(opacityOf('status-bar-scrim-cover')).toBe(0);
    });

    it('keeps white status glyphs at 3:1 or better over a white photo, and fades out smoothly', () => {
      // Captured: clear, the glyphs vanished; a linear 0.35 fade measured 2.1:1.
      const { HERO_TOP_FADE_STEPS: N, HERO_TOP_FADE_HOLD } = require('../StatusBarScrim');
      render(<StatusBarScrim overHero coverProgress={{ value: 0 } as any} />);
      const band = (i: number) =>
        StyleSheet.flatten(
          screen.getByTestId(`status-bar-hero-fade-${i}`, { includeHiddenElements: true }).props.style,
        );
      const alpha = (i: number) => Number(/rgba\(0,0,0,([\d.]+)\)/.exec(band(i).backgroundColor)![1]);
      const lum = (v: number) => {
        const c = v / 255;
        return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
      };
      const contrastOverWhite = (a: number) => 1.05 / (lum(255 * (1 - a)) + 0.05);

      expect(alpha(0)).toBeCloseTo(0.55, 3);
      // The glyph band: every step in the held top fraction clears 3:1.
      for (let i = 0; (i + 0.5) / N <= HERO_TOP_FADE_HOLD; i++) {
        expect(contrastOverWhite(alpha(i))).toBeGreaterThanOrEqual(3);
      }
      // Smooth: never darker going down, and no step jumps by more than 0.06.
      for (let i = 1; i < N; i++) {
        expect(alpha(i)).toBeLessThanOrEqual(alpha(i - 1));
        expect(alpha(i - 1) - alpha(i)).toBeLessThanOrEqual(0.06);
      }
      // Gone by the bottom of the status bar.
      expect(alpha(N - 1)).toBeLessThan(0.01);
      expect(band(N - 1).top + band(N - 1).height).toBeCloseTo(62, 5);
    });

    it('without a progress value draws only the fade, no cover', () => {
      render(<StatusBarScrim overHero />);
      expect(screen.queryByTestId('status-bar-scrim-cover', { includeHiddenElements: true })).toBeNull();
      expect(screen.queryByTestId('glass-plate')).toBeNull();
      expect(screen.getByTestId('status-bar-hero-fade-0', { includeHiddenElements: true })).toBeTruthy();
    });
  });
});
