// ux2 batch 25 M6: Remove and Keep on the pending removal card.

/* eslint-disable @typescript-eslint/no-require-imports */
import React from 'react';
import { act, fireEvent, render } from '@testing-library/react-native';

jest.mock('react-i18next', () => ({ useTranslation: () => ({ t: (k: string) => k }) }));
jest.mock('@/components/ui/text', () => {
  const { Text } = require('react-native');
  return { Text };
});
jest.mock('@/components/ui/button', () => {
  const R = require('react');
  const RN = require('react-native');
  return {
    Button: (p: any) => R.createElement(RN.Pressable, { ...p, disabled: p.isDisabled }, p.children),
    ButtonText: (p: any) => R.createElement(RN.Text, null, p.children),
  };
});
jest.mock('@expo/vector-icons', () => require('@/lib/__test-helpers__/icon-glyph-a11y').glyphIconModule());
jest.mock('react-native-reanimated', () => {
  const R = require('react');
  const RN = require('react-native');
  return { __esModule: true, default: { View: (p: any) => R.createElement(RN.View, p) }, withTiming: (v: unknown) => v };
});
jest.mock('@/components/custom/TranslatableDynamic', () => {
  const R = require('react');
  const RN = require('react-native');
  return { __esModule: true, default: (p: any) => R.createElement(RN.Text, null, p.text) };
});
const mockConfirm = jest.fn(async () => undefined);
jest.mock('../fact-choice-actions', () => ({ confirmPendingDelete: (...a: unknown[]) => mockConfirm(...(a as [])) }));

import FactCard from '../FactCard';
import { exposedGlyphTexts, privateUseLabelLeaks } from '@/lib/__test-helpers__/icon-glyph-a11y';

const pending = { resultKey: 'a1::0', baseResult: { pendingFactIds: ['h1'] }, factIds: ['h1'] };

beforeEach(() => mockConfirm.mockClear());

it('Remove confirms the removal of exactly the listed facts', async () => {
  const { getByTestId } = render(<FactCard action="deletePending" statements={['Lives in Porto']} pendingDelete={pending} />);
  await act(async () => { fireEvent.press(getByTestId('fact-delete-remove')); });
  expect(mockConfirm).toHaveBeenCalledWith(pending, 'remove');
});

it('Keep removes nothing', async () => {
  const { getByTestId } = render(<FactCard action="deletePending" statements={['Lives in Porto']} pendingDelete={pending} />);
  await act(async () => { fireEvent.press(getByTestId('fact-delete-keep')); });
  expect(mockConfirm).toHaveBeenCalledWith(pending, 'keep');
});

it('a card from history, with no pendingDelete, has no buttons', () => {
  const { queryByTestId } = render(<FactCard action="deletePending" statements={['Lives in Porto']} />);
  expect(queryByTestId('fact-delete-remove')).toBeNull();
});

it('the kept line is one sentence', () => {
  const { getByText } = render(<FactCard action="deleteKept" statements={[]} />);
  expect(getByText('floatingChat.factDeleteKept')).toBeTruthy();
});

it('leaks no icon glyph into an accessible label', () => {
  const { UNSAFE_root } = render(<FactCard action="deletePending" statements={['Lives in Porto']} pendingDelete={pending} />);
  expect(privateUseLabelLeaks(UNSAFE_root)).toEqual([]);
  // ux2 batch 26: no icon stands alone as its own StaticText either, and
  // the check is not vacuous: glyphs did render.
  expect(UNSAFE_root.findAll((n: any) => n.type === 'Text' && /[\uE000-\uF8FF]/.test(String(n.props.children))).length).toBeGreaterThan(0);
  expect(exposedGlyphTexts(UNSAFE_root)).toEqual([]);
});
