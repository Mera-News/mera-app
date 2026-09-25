// ux2 batch 26: the two shapes every labelled chat button with an icon uses.
// On iOS a glyph under ANY accessible ancestor surfaced as its own StaticText,
// so the accessible element is a childless Pressable and the icon sits beside
// it, never inside it.

/* eslint-disable @typescript-eslint/no-require-imports */
import React from 'react';
import { fireEvent, render } from '@testing-library/react-native';
import { StyleSheet, Text } from 'react-native';

jest.mock('@expo/vector-icons', () => require('@/lib/__test-helpers__/icon-glyph-a11y').glyphIconModule());

import { MaterialIcons } from '@expo/vector-icons';
import { DECORATIVE_ICON_A11Y } from '@/components/custom/decorative-icon';
import { exposedGlyphTexts } from '@/lib/__test-helpers__/icon-glyph-a11y';
import { GlyphSafeButton, GlyphSafeIconButton, TOUCH_FRAME } from '../glyph-safe';

const hostKids = (n: any) => n.findAll((c: any) => typeof c.type === 'string' && c !== n);

it('GlyphSafeButton: a childless labelled button over a hidden visual', () => {
  const onPress = jest.fn();
  const { getByTestId, UNSAFE_root } = render(
    <GlyphSafeButton testID="b" accessibilityLabel="Undo" onPress={onPress} visualStyle={{ padding: 4 }}>
      <MaterialIcons {...DECORATIVE_ICON_A11Y} name="undo" size={18} />
      <Text>Undo</Text>
    </GlyphSafeButton>,
  );
  const button = getByTestId('b');
  expect(button.props.accessibilityRole).toBe('button');
  expect(hostKids(button)).toHaveLength(0);
  expect(StyleSheet.flatten(button.props.style)).toMatchObject({ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 });
  expect(exposedGlyphTexts(UNSAFE_root)).toEqual([]);
  fireEvent.press(button);
  expect(onPress).toHaveBeenCalledTimes(1);
});

it('GlyphSafeButton: the role can be a radio or a checkbox', () => {
  const { getByTestId } = render(
    <GlyphSafeButton testID="r" accessibilityRole="radio" accessibilityLabel="Porto">
      <MaterialIcons {...DECORATIVE_ICON_A11Y} name="radio-button-checked" size={18} />
    </GlyphSafeButton>,
  );
  expect(getByTestId('r').props.accessibilityRole).toBe('radio');
});

it('GlyphSafeIconButton: a 44x44 childless frame sized by number, the icon beside it', () => {
  expect(TOUCH_FRAME).toBe(44);
  const { getByTestId, UNSAFE_root } = render(
    <GlyphSafeIconButton testID="i" accessibilityLabel="Close">
      <MaterialIcons {...DECORATIVE_ICON_A11Y} name="close" size={22} />
    </GlyphSafeIconButton>,
  );
  const frame = getByTestId('i');
  const flat = StyleSheet.flatten(frame.props.style);
  expect(flat.width).toBe(44);
  expect(flat.height).toBe(44);
  expect(hostKids(frame)).toHaveLength(0);
  expect(exposedGlyphTexts(UNSAFE_root)).toEqual([]);
});

it('the helper does catch an icon inside a labelled button (the check is not vacuous)', () => {
  const { Pressable } = require('react-native');
  const { UNSAFE_root } = render(
    <Pressable accessibilityLabel="Close">
      <MaterialIcons {...DECORATIVE_ICON_A11Y} name="close" size={22} />
    </Pressable>,
  );
  expect(exposedGlyphTexts(UNSAFE_root)).toHaveLength(1);
});
