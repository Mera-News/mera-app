/**
 * useAdaptiveLineClamp: a `numberOfLines` clamp that grows with the text. Its two inputs are the
 * OS font scale (the window's `fontScale`, which re-renders the hook when it changes) and the
 * in-app text-size control (the real text-scale store, delivered through the real
 * TextScaleProvider). The OS side is driven through RN's own `Dimensions`.
 */
import React from 'react';
import { Dimensions } from 'react-native';
import { act, renderHook } from '@testing-library/react-native';

import { MAX_FONT_SCALE } from '@/lib/algorithms/policy';
import { TextScaleProvider } from '@/lib/typography/TextScaleProvider';
import { useAdaptiveLineClamp } from '@/lib/typography/useAdaptiveLineClamp';
import { useTextScaleStore, type TextScale } from '@/lib/stores/text-scale-store';

const original = Dimensions.get('window');

const setOsFontScale = (fontScale: number) =>
  act(() => {
    Dimensions.set({ window: { ...original, fontScale }, screen: Dimensions.get('screen') });
  });
const setUserScale = (scale: number) => act(() => useTextScaleStore.setState({ scale: scale as TextScale }));

const clamp = (base: number, max?: number) =>
  renderHook(() => useAdaptiveLineClamp(base, max), { wrapper: TextScaleProvider as React.ComponentType });

beforeEach(async () => {
  await setOsFontScale(1);
  await setUserScale(1);
});
afterAll(async () => {
  await setOsFontScale(original.fontScale);
});

describe('useAdaptiveLineClamp', () => {
  it('returns base exactly at 1x, so default rendering is untouched', async () => {
    expect((await clamp(3, 4)).result.current).toBe(3);
  });

  it('returns base when the scales would shrink the text, never less', async () => {
    await setUserScale(0.85);
    expect((await clamp(3, 4)).result.current).toBe(3);
  });

  it('grows the allowance with the text', async () => {
    await setOsFontScale(1.5);
    // round(3 * 1.5) = 5, clipped by the ceiling.
    expect((await clamp(3, 6)).result.current).toBe(5);
  });

  it('never exceeds the ceiling', async () => {
    await setOsFontScale(2);
    expect((await clamp(3, 4)).result.current).toBe(4);
  });

  it('caps the OS contribution where the glyphs themselves stop growing', async () => {
    // Past MAX_FONT_SCALE.content the text is capped, so the allowance must be
    // too: an OS scale beyond it buys no extra lines.
    await setOsFontScale(MAX_FONT_SCALE.content);
    const atCap = (await clamp(3, 99)).result.current;
    await setOsFontScale(MAX_FONT_SCALE.content * 4);
    expect((await clamp(3, 99)).result.current).toBe(atCap);
  });

  it('compounds the OS scale with the in-app text-size control', async () => {
    await setOsFontScale(1.2);
    await setUserScale(1.3);
    // round(2 * 1.2 * 1.3) = round(3.12) = 3
    expect((await clamp(2, 9)).result.current).toBe(3);
  });

  it('defaults the ceiling to twice base', async () => {
    await setOsFontScale(MAX_FONT_SCALE.content);
    await setUserScale(4);
    expect((await clamp(3)).result.current).toBe(6);
  });

  it('re-renders when the OS text size changes while mounted', async () => {
    const { result } = await clamp(3, 6);
    expect(result.current).toBe(3);
    await setOsFontScale(1.5);
    expect(result.current).toBe(5);
  });
});
