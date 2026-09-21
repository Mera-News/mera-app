// FactChoiceCard — the card must resolve only ITS OWN group.
//
// deriveThreadItems and fact-choice-actions are covered separately, so what is
// left to prove here is the seam this component owns: that a tap commits the
// selected reading, resolves exactly one groupId, and passes the staged result
// through so the first tap of a turn has a spine to merge into. The shipped bug
// was a component that decided "am I answered" from the presence of ANY value at
// the shared resultKey, which is invisible to a pure-function test.
/* eslint-disable @typescript-eslint/no-require-imports */

import { fireEvent, render, waitFor } from '@testing-library/react-native';
import React from 'react';

jest.mock('react-i18next', () => ({ useTranslation: () => ({ t: (k: string) => k }) }));
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
jest.mock('@/components/custom/TranslatableDynamic', () => {
  const { Text } = require('react-native');
  return { __esModule: true, default: ({ text }: any) => <Text>{text}</Text> };
});
jest.mock('@/lib/haptics', () => ({ hapticLight: jest.fn(), hapticSuccess: jest.fn() }));
// Both services build their collections at MODULE SCOPE, so importing the
// card reaches SQLiteAdapter and dies on `initializeJSI` before any test body
// runs. The replacement disclosure is the only thing that reads them.
jest.mock('@/lib/database/services/fact-service', () => ({
  getFacts: jest.fn(async () => []),
}));
jest.mock('@/lib/database/services/topic-service', () => ({
  getByFact: jest.fn(async () => []),
}));
jest.mock('@/lib/logger', () => ({
  __esModule: true,
  default: { error: jest.fn(), warn: jest.fn(), debug: jest.fn() },
}));

const mockCommit = jest.fn().mockResolvedValue({ savedFacts: [], conflicts: [] });
jest.mock('@/lib/chat-tools/fact-commit', () => ({
  commitFactChoices: (...a: unknown[]) => mockCommit(...a),
}));

const mockResolveGroup = jest.fn();
jest.mock('../fact-choice-actions', () => ({
  resolveGroup: (...a: unknown[]) => mockResolveGroup(...a),
}));

import FactChoiceCard from '../FactChoiceCard';

const BASE = { pendingFacts: [{ index: 0, options: ['Lives in Hoorn'] }] };

const props = {
  resultKey: 'm1::0',
  baseResult: BASE,
  groupIndex: 0,
  groupId: '0:abcd1234',
  options: ['Lives in Hoorn, Netherlands', 'Works in Hoorn, Netherlands'],
  questionnaireAttribute: 'location: residence',
};

beforeEach(() => {
  mockCommit.mockClear().mockResolvedValue({ savedFacts: [], conflicts: [] });
  mockResolveGroup.mockClear();
});

describe('Add', () => {
  it('commits the PRESELECTED reading and resolves only this groupId', async () => {
    const { getByTestId } = render(<FactChoiceCard {...props} />);
    fireEvent.press(getByTestId('fact-choice-add-0'));

    await waitFor(() => expect(mockResolveGroup).toHaveBeenCalledTimes(1));
    // options[0] is Mera's preferred reading and is preselected, so the
    // unambiguous case really is one tap.
    expect(mockCommit).toHaveBeenCalledWith([
      {
        statement: 'Lives in Hoorn, Netherlands',
        questionnaire: { attribute: 'location: residence' },
      },
    ]);
    const [resultKey, groupId, resolution, base] = mockResolveGroup.mock.calls[0];
    expect(resultKey).toBe('m1::0');
    expect(groupId).toBe('0:abcd1234');
    expect(resolution).toMatchObject({ status: 'saved' });
    // The staged result MUST be forwarded: the store holds overrides only, so
    // without it the first tap of a turn merges into undefined and every card
    // in the group disappears.
    expect(base).toBe(BASE);
  });

  it('commits the reading the user actually selected', async () => {
    const { getByTestId } = render(<FactChoiceCard {...props} />);
    fireEvent.press(getByTestId('fact-choice-option-0-1'));
    fireEvent.press(getByTestId('fact-choice-add-0'));

    await waitFor(() => expect(mockCommit).toHaveBeenCalled());
    expect(mockCommit.mock.calls[0][0][0].statement).toBe('Works in Hoorn, Netherlands');
  });

  it('keeps the questionnaire attribute, which anchors every future topic run', async () => {
    const { getByTestId } = render(<FactChoiceCard {...props} />);
    fireEvent.press(getByTestId('fact-choice-add-0'));
    await waitFor(() => expect(mockCommit).toHaveBeenCalled());
    expect(mockCommit.mock.calls[0][0][0].questionnaire).toEqual({
      attribute: 'location: residence',
    });
  });

  it('does not resolve the group when the commit throws', async () => {
    mockCommit.mockRejectedValueOnce(new Error('db down'));
    const { getByTestId } = render(<FactChoiceCard {...props} />);
    fireEvent.press(getByTestId('fact-choice-add-0'));
    // Resolving anyway would settle the card and unblock the composer over a
    // fact that was never written.
    await waitFor(() => expect(mockCommit).toHaveBeenCalled());
    expect(mockResolveGroup).not.toHaveBeenCalled();
  });
});

describe('Skip and Undo', () => {
  it('Skip records a dismissal and writes nothing', () => {
    const { getByTestId } = render(<FactChoiceCard {...props} />);
    fireEvent.press(getByTestId('fact-choice-dismiss-0'));
    expect(mockCommit).not.toHaveBeenCalled();
    expect(mockResolveGroup).toHaveBeenCalledWith(
      'm1::0',
      '0:abcd1234',
      { status: 'dismissed', options: props.options, questionnaireAttribute: 'location: residence' },
      BASE,
    );
  });

  it('a dismissed card shows the settled line with Undo, not the readings', () => {
    const { getByTestId, queryByTestId } = render(<FactChoiceCard {...props} dismissed />);
    expect(getByTestId('fact-choice-dismissed-0')).toBeTruthy();
    expect(getByTestId('fact-choice-undo-0')).toBeTruthy();
    expect(queryByTestId('fact-choice-add-0')).toBeNull();
  });

  it('Undo clears the entry, returning the group to pending', () => {
    const { getByTestId } = render(<FactChoiceCard {...props} dismissed />);
    fireEvent.press(getByTestId('fact-choice-undo-0'));
    expect(mockResolveGroup).toHaveBeenCalledWith('m1::0', '0:abcd1234', undefined, BASE);
  });

  it('a STALE dismissed card offers no Undo — its context is gone', () => {
    const { queryByTestId } = render(<FactChoiceCard {...props} dismissed stale />);
    expect(queryByTestId('fact-choice-undo-0')).toBeNull();
  });
});

describe('inert states', () => {
  it('a stale card offers no buttons at all, so it cannot commit', () => {
    // Stronger than "the handler refuses": the affordance is absent, so a card
    // from an earlier conversation cannot be tapped in the first place. It is
    // also why the composer gate excludes stale cards — a blocked input with no
    // visible way to clear it is unrecoverable.
    const { queryByTestId, getByText } = render(<FactChoiceCard {...props} stale />);
    expect(queryByTestId('fact-choice-add-0')).toBeNull();
    expect(queryByTestId('fact-choice-dismiss-0')).toBeNull();
    expect(getByText('factChoice.expired')).toBeTruthy();
  });

  it('a single-option card offers no radio to change', () => {
    const { queryByTestId, getByTestId } = render(
      <FactChoiceCard {...props} options={['Lives in Hoorn']} />,
    );
    expect(getByTestId('fact-choice-option-0-0')).toBeTruthy();
    expect(queryByTestId('fact-choice-option-0-1')).toBeNull();
  });
});
