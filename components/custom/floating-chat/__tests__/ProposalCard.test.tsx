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
jest.mock('@expo/vector-icons', () => require('@/lib/__test-helpers__/icon-glyph-a11y').glyphIconModule());
jest.mock('react-native-reanimated', () => {
  const { View } = require('react-native');
  return {
    __esModule: true,
    default: { View: ({ entering, ...p }: any) => <View {...p} /> },
    withTiming: (v: unknown) => v,
  };
});
jest.mock('@/lib/haptics', () => ({ hapticSuccess: jest.fn() }));
// Display-translation wrapper → a plain Text of the SOURCE string. Mirrors the
// cards suite. Without it the real component drags in `expo-translate-text`,
// whose native module does not exist under jest ("Cannot find native module
// 'ExpoTranslateText'"), and the whole suite fails to load.
// `mockTranslate` on: the line shows (and reports, as the real component
// does) a translated rendering, so a label built from it can be checked.
let mockTranslate = false;
jest.mock('@/components/custom/TranslatableDynamic', () => {
  const R = require('react');
  const { Text } = require('react-native');
  return {
    __esModule: true,
    default: ({ text, onDisplayChange }: any) => {
      const shown = mockTranslate ? `DE:${text}` : text;
      R.useEffect(() => {
        onDisplayChange?.({ showingOriginal: !mockTranslate, displayedText: shown, displayedLanguage: mockTranslate ? 'de' : 'en' });
      }, [shown]);
      return <Text>{shown}</Text>;
    },
  };
});

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
import { exposedGlyphTexts } from '@/lib/__test-helpers__/icon-glyph-a11y';

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

  // G1: the tap is the ONLY consent path for a single-select card (both agents'
  // applyProposal now refuse one), so this is the assertion that keeps the pills
  // meaningful: Confirm applies EXACTLY the picked scope — not all three.
  it('applies exactly the SELECTED scope, as a user-confirmed call', async () => {
    const { getByTestId, getByText } = render(<ProposalCard proposal={trackProposal} isLast />);

    fireEvent.press(getByTestId('proposal-action-row-1'));
    fireEvent.press(getByText('articleFeedback.proposalConfirm'));

    await waitFor(() => expect(mockExecuteProposalActions).toHaveBeenCalledTimes(1));
    expect(mockExecuteProposalActions).toHaveBeenCalledWith([trackProposal.actions[1]], {
      confirmedByUser: true,
    });
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

// A structured filter is a different promise from a keyword one (exact match on
// ONE article field vs "anywhere in the story"), so the card has to SAY which.
describe('ProposalCard filter rows', () => {
  const filterProposal: StagedProposal = {
    id: 'p1',
    explanation: '',
    expectedEffects: '',
    actions: [
      {
        type: 'add_suppression',
        suppressionPattern: 'Entertainment',
        suppressionKind: 'category',
        suppressionValue: 'Entertainment',
      },
      { type: 'add_suppression', suppressionPattern: 'celebrity gossip' },
      { type: 'retire_suppression', suppressionId: 'sup-1', pattern: 'football' },
    ],
  };

  it('shows a kind chip for a structured filter, none for a keyword one', () => {
    const { queryByText } = render(<ProposalCard proposal={filterProposal} isLast />);
    // The chip reuses the Not-interested screen's kind strings.
    expect(queryByText('notInterested.kinds.category')).not.toBeNull();
    expect(queryByText('notInterested.kinds.keyword')).toBeNull();
  });

  it('renders retire_suppression as its own labelled row, not the generic guard row', () => {
    const { queryByText } = render(<ProposalCard proposal={filterProposal} isLast />);
    expect(queryByText('articleFeedback.actionRetireSuppression')).not.toBeNull();
    expect(queryByText('football')).not.toBeNull();
  });
});

// F34: the track card says what to do in plain words, and does not repeat
// "Follow story" over every option the title already names.
describe('ProposalCard track copy', () => {
  it('asks the reader to choose what to follow, once', () => {
    const { queryByText, queryAllByText } = render(<ProposalCard proposal={trackProposal} isLast />);
    expect(queryByText('floatingChat.trackChooseHint')).not.toBeNull();
    expect(queryByText('articleFeedback.chooseOneHint')).toBeNull();
    expect(queryAllByText('trackedStories.trackAction')).toHaveLength(0);
  });
});

describe('ux2 batch 26: radio rows keep their glyphs out of the accessibility tree', () => {
  it('a pending choose-one card exposes no glyph, and each row reads its own words', () => {
    const { UNSAFE_root, getByTestId } = render(<ProposalCard proposal={trackProposal} isLast />);
    const glyphs = UNSAFE_root.findAll((n: any) => n.type === 'Text' && /[\uE000-\uF8FF]/.test(String(n.props.children)));
    expect(glyphs.length).toBeGreaterThan(0);
    expect(exposedGlyphTexts(UNSAFE_root)).toEqual([]);
    const label = getByTestId('proposal-action-row-0').props.accessibilityLabel;
    expect(typeof label).toBe('string');
    expect(label.length).toBeGreaterThan(0);
  });
});

it('ux2 batch 26: a choose-one row reads the words it SHOWS, translated when they are', () => {
  mockTranslate = true;
  try {
    const { getByTestId } = render(<ProposalCard proposal={trackProposal} isLast />);
    const label: string = getByTestId('proposal-action-row-0').props.accessibilityLabel;
    expect(label).toContain('DE:');
  } finally {
    mockTranslate = false;
  }
});
