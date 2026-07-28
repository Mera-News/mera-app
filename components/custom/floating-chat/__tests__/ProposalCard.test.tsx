// ProposalCard — applied/cancelled state must read as TERMINAL: the scope rows
// lose their press affordance AND their full contrast once the user confirms.
/* eslint-disable @typescript-eslint/no-require-imports */

import type { StagedProposal } from '@/lib/llm/types';
import { fireEvent, render, waitFor } from '@testing-library/react-native';
import React from 'react';
import { StyleSheet } from 'react-native';

// ── UI primitives / native seams → plain RN ──
jest.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
jest.mock('@/components/ui/text', () => {
  const { Text } = require('react-native');
  return { Text };
});
jest.mock('@/components/ui/button', () => {
  const { Pressable, Text } = require('react-native');
  return {
    Button: (p: any) => <Pressable {...p} />,
    ButtonText: (p: any) => <Text {...p} />,
  };
});
jest.mock('@expo/vector-icons', () => {
  const { View } = require('react-native');
  return { MaterialIcons: (p: any) => <View {...p} /> };
});
jest.mock('react-native-reanimated', () => {
  const { View } = require('react-native');
  return {
    __esModule: true,
    default: { View: ({ entering, ...p }: any) => <View {...p} /> },
    withTiming: (v: unknown) => v,
  };
});
jest.mock('@/lib/haptics', () => ({ hapticSuccess: jest.fn() }));

const mockExecuteProposalActions = jest.fn().mockResolvedValue(undefined);
jest.mock('@/lib/chat-tools/proposal-handlers', () => ({
  executeProposalActions: (...args: unknown[]) => mockExecuteProposalActions(...args),
}));

const mockResolveProposal = jest.fn();
jest.mock('@/lib/stores/floating-chat-store', () => ({
  useFloatingChatIsGenerating: () => false,
  useFloatingChatProposal: () => ({ id: 'p1' }),
  useFloatingChatResolvedProposals: () => ({}),
  useFloatingChatStore: { getState: () => ({ resolveProposal: mockResolveProposal }) },
}));

import ProposalCard from '../ProposalCard';

const subject = {
  origin: 'article' as const,
  surface: 'detail',
  articleId: 'a1',
  title: 'Russia strikes humanitarian sites in Ukraine',
  stableClusterId: null,
  publicationName: null,
};

const trackProposal: StagedProposal = {
  id: 'p1',
  explanation: '',
  expectedEffects: '',
  chooseOne: true,
  actions: [
    { type: 'track_story', label: 'Attacks on Ukraine infrastructure', searchText: 's1', subject },
    { type: 'track_story', label: 'Russia–Ukraine war', searchText: 's2', subject },
    { type: 'track_story', label: 'European security crisis', searchText: 's3', subject },
  ],
};

const opacityOf = (node: { props: { style?: unknown } }) =>
  (StyleSheet.flatten(node.props.style as never) as { opacity?: number } | undefined)?.opacity;

describe('ProposalCard applied state', () => {
  beforeEach(() => {
    mockExecuteProposalActions.mockClear();
    mockResolveProposal.mockClear();
  });

  it('renders scope rows as tappable radios while pending', () => {
    const { getByTestId } = render(<ProposalCard proposal={trackProposal} isLast />);
    const row = getByTestId('proposal-action-row-1');
    expect(row.props.accessibilityState).toEqual({ selected: false });
    // Selecting a different option is honoured while pending.
    fireEvent.press(row);
    expect(getByTestId('proposal-action-row-1').props.accessibilityState.selected).toBe(true);
    expect(opacityOf(getByTestId('proposal-actions'))).toBeUndefined();
  });

  it('dims and disables the rows once the proposal is applied', async () => {
    const { getByTestId, getByText, queryByText } = render(
      <ProposalCard proposal={trackProposal} isLast />,
    );

    fireEvent.press(getByText('articleFeedback.proposalConfirm'));

    await waitFor(() => expect(queryByText('articleFeedback.proposalApplied')).not.toBeNull());

    expect(mockExecuteProposalActions).toHaveBeenCalledTimes(1);
    expect(mockResolveProposal).toHaveBeenCalledWith('applied');

    // Terminal: reduced contrast on the whole action block…
    expect(opacityOf(getByTestId('proposal-actions'))).toBe(0.5);
    // …and every row is a non-pressable, explicitly-disabled radio.
    for (const idx of [0, 1, 2]) {
      const row = getByTestId(`proposal-action-row-${idx}`);
      expect(row.props.accessibilityState.disabled).toBe(true);
      expect(row.props.onStartShouldSetResponder).toBeUndefined();
    }
  });

  it('dims the rows when the proposal is cancelled', async () => {
    const { getByTestId, getByText, queryByText } = render(
      <ProposalCard proposal={trackProposal} isLast />,
    );

    fireEvent.press(getByText('articleFeedback.proposalCancel'));

    await waitFor(() => expect(queryByText('articleFeedback.proposalCancelled')).not.toBeNull());
    expect(opacityOf(getByTestId('proposal-actions'))).toBe(0.5);
    expect(getByTestId('proposal-action-row-0').props.accessibilityState.disabled).toBe(true);
  });
});
