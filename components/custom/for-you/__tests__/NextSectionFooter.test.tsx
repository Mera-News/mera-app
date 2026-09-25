/* eslint-disable @typescript-eslint/no-require-imports */
// N13: the fact feed's "Next" row takes the NEXT section's gradient, never says
// "0", offers "Back to Dashboard" on the last section, and keeps 4.5:1 on every
// possible section hue.
import fs from 'fs';
import path from 'path';
import { hashString, SECTION_LIGHTNESS_PCT, SECTION_SATURATION_PCT, sectionGradient } from '@/lib/section-color';
import { contrastRatio, parseRgb } from '../status-ink';

jest.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (k: string, v?: Record<string, unknown>) => (v ? `${k}:${JSON.stringify(v)}` : k),
  }),
}));
jest.mock('@/components/custom/for-you/SectionGradientPanel', () => {
  const { View } = require('react-native');
  return { __esModule: true, default: (p: any) => <View testID={`panel-${p.factId}`} style={p.style}>{p.children}</View> };
});
jest.mock('@/components/custom/TranslatableDynamic', () => {
  const { Text } = require('react-native');
  return { __esModule: true, default: (p: any) => <Text>{p.text}</Text> };
});
jest.mock('@/components/custom/GlassSurface', () => ({ GLASS_OVER_CONTENT_FILL: 'rgba(18,17,19,0.90)' }));
jest.mock('@/components/ui/text', () => {
  const { Text } = require('react-native');
  return { Text: (p: any) => <Text {...p} /> };
});
jest.mock('@/components/ui/hstack', () => {
  const { View } = require('react-native');
  return { HStack: (p: any) => <View {...p} /> };
});
jest.mock('@/components/ui/vstack', () => {
  const { View } = require('react-native');
  return { VStack: (p: any) => <View {...p} /> };
});
jest.mock('@/components/ui/pressable', () => {
  const { Pressable } = require('react-native');
  return { Pressable };
});
// Real icon-font glyphs, so a glyph under an accessible element is caught.
jest.mock('@expo/vector-icons', () => require('@/lib/__test-helpers__/icon-glyph-a11y').glyphIconModule());

import { fireEvent, render, screen } from '@testing-library/react-native';
import React from 'react';
import NextSectionFooter, { NEXT_FOOTER_INK } from '../NextSectionFooter';

function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  const a = s * Math.min(l, 1 - l);
  const f = (n: number) => {
    const k = (n + h / 30) % 12;
    return l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1));
  };
  return [f(0) * 255, f(8) * 255, f(4) * 255];
}
const over = (top: number[], alpha: number, under: number[]) =>
  top.map((c, i) => c * alpha + under[i] * (1 - alpha)) as [number, number, number];

const HIDDEN = { includeHiddenElements: true } as const;

describe('NextSectionFooter', () => {
  // Captured (ux2 batch 27): the "Next" row's chevron was its own StaticText
  // inside the labelled button. Both rows are childless labelled buttons laid
  // over a hidden visual.
  it.each(['next', 'back'] as const)('%s: no private-use StaticText, and the button is childless', (kind) => {
    const r = render(
      kind === 'next'
        ? <NextSectionFooter kind="next" factId="f2" title="Formula 1" count={12} translateTitle onPress={jest.fn()} />
        : <NextSectionFooter kind="back" onPress={jest.fn()} />,
    );
    const glyphs = r.UNSAFE_root.findAll(
      (n: any) => typeof n.type === 'string' && /[\uE000-\uF8FF]/.test(String(n.props?.children ?? '')),
    );
    expect(glyphs.length).toBe(1);
    for (const g of glyphs) {
      expect(g.props.accessible).toBe(false);
      expect(g.props.accessibilityElementsHidden).toBe(true);
      expect(g.props.importantForAccessibility).toBe('no-hide-descendants');
      for (let p: any = g.parent; p; p = p.parent) expect(p.props?.accessible).not.toBe(true);
    }
    const button = r.getByTestId(kind === 'next' ? 'fact-feed-next' : 'fact-feed-back-to-dashboard');
    expect(button.findAll((n: any) => n !== button && typeof n.type === 'string' && n.type !== 'View')).toHaveLength(0);
    expect(button.props.accessibilityRole).toBe('button');
  });

  it('draws the NEXT section gradient on a dark base, with the count', () => {
    render(
      <NextSectionFooter kind="next" factId="f2" title="Formula 1" count={12} translateTitle onPress={jest.fn()} />,
    );
    // The visual is hidden from accessibility: the button over it carries the label.
    const panel = screen.getByTestId('panel-f2', HIDDEN);
    expect(panel.props.style).toEqual(expect.objectContaining({ backgroundColor: 'rgba(18,17,19,0.90)' }));
    expect(screen.getByText('Formula 1', HIDDEN)).toBeTruthy();
    expect(screen.getByTestId('fact-feed-next-count', HIDDEN).props.children).toBe('trackedStories.articleCount:{"count":12}');
  });

  it('never says 0 for an empty next section', () => {
    render(<NextSectionFooter kind="next" factId="f3" title="Cooking" count={0} translateTitle onPress={jest.fn()} />);
    expect(screen.queryByTestId('fact-feed-next-count', HIDDEN)).toBeNull();
    expect(screen.getByTestId('fact-feed-next').props.accessibilityLabel).toBe('forYou.nextSection:{"title":"Cooking"}');
  });

  it('offers the way back on the last section', () => {
    const onPress = jest.fn();
    render(<NextSectionFooter kind="back" onPress={onPress} />);
    fireEvent.press(screen.getByTestId('fact-feed-back-to-dashboard'));
    expect(onPress).toHaveBeenCalled();
  });

  it('keeps white text at 4.5:1 on every section hue, over even a white backdrop', () => {
    const spec = sectionGradient('any');
    const base = over([18, 17, 19], 0.9, [255, 255, 255]);
    let worst = Infinity;
    for (let hue = 0; hue < 360; hue++) {
      const tint = hslToRgb(hue, SECTION_SATURATION_PCT / 100, SECTION_LIGHTNESS_PCT / 100);
      const bg = over(tint, spec.startOpacity, base);
      worst = Math.min(worst, contrastRatio(parseRgb(NEXT_FOOTER_INK), bg));
    }
    expect(worst).toBeGreaterThanOrEqual(4.5);
    expect(hashString('x')).toBeGreaterThan(0);
  });

  it('THE CONTROL: without the dark base the same white fails on some hue', () => {
    const spec = sectionGradient('any');
    let worst = Infinity;
    for (let hue = 0; hue < 360; hue++) {
      const tint = hslToRgb(hue, SECTION_SATURATION_PCT / 100, SECTION_LIGHTNESS_PCT / 100);
      worst = Math.min(worst, contrastRatio([255, 255, 255], over(tint, spec.startOpacity, [255, 255, 255])));
    }
    expect(worst).toBeLessThan(4.5);
  });
});

describe('FactFeedScreen hop', () => {
  it('keeps router.replace for "Next", marking the arrival for the crossfade', () => {
    const src = fs.readFileSync(path.resolve(__dirname, '../FactFeedScreen.tsx'), 'utf8');
    expect(src).toMatch(/router\.replace\(\{\s*pathname: '\/logged-in\/fact-feed',\s*params: \{[^}]*via: 'next'/);
    expect(src).not.toMatch(/router\.setParams/);
    expect(src).toMatch(/<NextSectionFooter/);
  });

  it('crossfades the replaced screen in, and only for a Next hop', () => {
    const layout = fs.readFileSync(path.resolve(__dirname, '../../../../app/logged-in/_layout.tsx'), 'utf8');
    const block = layout.slice(layout.indexOf('name="fact-feed"'), layout.indexOf('name="facts"'));
    expect(block).toMatch(/via === 'next'\s*\?\s*'fade'\s*:\s*'slide_from_right'/);
  });

  it('shows no empty state until the new section has loaded (no "caught up" flash on a hop)', () => {
    const src = fs.readFileSync(path.resolve(__dirname, '../FactFeedScreen.tsx'), 'utf8');
    expect(src).toMatch(/const listEmpty = snapshots === null \? null/);
  });
});

