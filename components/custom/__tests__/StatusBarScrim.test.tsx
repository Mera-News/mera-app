/* eslint-disable @typescript-eslint/no-require-imports */
// F21: content scrolled up under the status bar read straight through the
// strip ("News about:" over the clock). The strip is over CONTENT, so it takes
// the over-content base, not the 0.42 header scrim.
jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 62, bottom: 34, left: 0, right: 0 }),
}));
jest.mock('@/components/custom/GlassSurface', () => {
  const { View } = require('react-native');
  return {
    GLASS_HEADER_TINT: 'rgba(255,255,255,0.16)',
    GLASS_OVER_CONTENT_FILL: 'rgba(18,17,19,0.90)',
    GlassHeaderAndroidBackdrop: () => null,
    GlassPlate: () => <View testID="glass-plate" />,
  };
});

import { render, screen } from '@testing-library/react-native';
import React from 'react';
import { StyleSheet } from 'react-native';
import StatusBarScrim from '../StatusBarScrim';

describe('StatusBarScrim', () => {
  it('paints the over-content base behind the status bar', () => {
    render(<StatusBarScrim />);
    const style = StyleSheet.flatten(screen.getByTestId('status-bar-scrim').props.style);
    expect(style.backgroundColor).toBe('rgba(18,17,19,0.90)');
    expect(style.height).toBe(62);
  });

  it('fades out below the strip instead of ending on a hard line', () => {
    render(<StatusBarScrim />);
    const first = StyleSheet.flatten(screen.getByTestId('status-bar-scrim-fade-0').props.style);
    expect(first.top).toBe(62);
    expect(screen.getByTestId('status-bar-scrim-fade-2')).toBeTruthy();
  });
});
