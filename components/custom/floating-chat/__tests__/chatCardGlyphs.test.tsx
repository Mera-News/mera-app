// ux2 batch 25: chat cards never let VoiceOver read an icon-font glyph.

/* eslint-disable @typescript-eslint/no-require-imports */
import React from 'react';
import { render } from '@testing-library/react-native';

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
jest.mock('@/lib/haptics', () => ({ hapticLight: jest.fn(), hapticSuccess: jest.fn() }));
jest.mock('@/lib/logger', () => ({ __esModule: true, default: { error: jest.fn(), warn: jest.fn() } }));
jest.mock('@/lib/chat-tools/fact-commit', () => ({ commitFactChoices: jest.fn() }));
jest.mock('../fact-choice-actions', () => ({ resolveGroup: jest.fn() }));
jest.mock('@/lib/database/services/fact-service', () => ({ getFacts: async () => [], deleteFact: jest.fn(), updateFact: jest.fn() }));
jest.mock('@/lib/database/services/topic-service', () => ({ getByFact: async () => [], reassignTopics: jest.fn() }));
jest.mock('@/lib/stores/floating-chat-store', () => ({
  useFloatingChatStore: Object.assign((sel: (s: unknown) => unknown) => sel({ resolvedConflicts: {}, resolveConflict: jest.fn() }), {
    getState: () => ({ resolvedConflicts: {}, resolveConflict: jest.fn() }),
  }),
  useFloatingChatResolvedConflicts: () => ({}),
}));

import { FactChoiceCard } from '../FactChoiceCard';
import ConflictResolutionCard from '../ConflictResolutionCard';
import { privateUseLabelLeaks } from '@/lib/__test-helpers__/icon-glyph-a11y';

it('fact-choice readings leak no glyph', () => {
  const { UNSAFE_root } = render(
    <FactChoiceCard resultKey="m1::0" baseResult={{}} groupIndex={0} groupId="g0"
      options={['Lives in Porto', 'Lives in Porto Alegre']} questionnaireAttribute={null} />,
  );
  expect(privateUseLabelLeaks(UNSAFE_root)).toEqual([]);
});

it('conflict choices leak no glyph', () => {
  const { UNSAFE_root } = render(
    <ConflictResolutionCard conflict={{
      newFactId: 'n', newStatement: 'Lives in Porto', existingFactId: 'e', existingStatement: 'Lives in Berlin',
      kind: 'attribute', suggestedMerge: 'Lives in Porto and Berlin',
    }} />,
  );
  expect(privateUseLabelLeaks(UNSAFE_root)).toEqual([]);
});
