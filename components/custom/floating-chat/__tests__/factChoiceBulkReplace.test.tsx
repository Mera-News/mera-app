// ux2 owner ruling: the bulk row under 2+ pending cards offers Replace all /
// Keep all / Skip all when any of them is a replace card.
//
// THE MIXED RULE, stated once: "Replace all" replaces on every replace card and
// ADDS every add card; "Keep all" adds every card and replaces nothing; "Skip
// all" dismisses every card. Each card commits its preferred reading.

/* eslint-disable @typescript-eslint/no-require-imports */
import React from 'react';
import { act, fireEvent, render } from '@testing-library/react-native';

jest.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (k: string) => k }),
}));
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
jest.mock('@/lib/haptics', () => ({ hapticLight: jest.fn(), hapticSuccess: jest.fn() }));
jest.mock('@/lib/logger', () => ({ __esModule: true, default: { error: jest.fn() } }));

const mockCommit = jest.fn(async (choices: { statement: string }[]) => ({
  savedFacts: choices.map((c, i) => ({ id: `new${i}`, statement: c.statement })),
  conflicts: [],
}));
jest.mock('@/lib/chat-tools/fact-commit', () => ({
  commitFactChoices: (...a: unknown[]) => mockCommit(...(a as [never])),
}));
const mockResolveGroups = jest.fn();
jest.mock('../fact-choice-actions', () => ({ resolveGroups: (...a: unknown[]) => mockResolveGroups(...a) }));

import FactChoiceBulkRow from '../FactChoiceBulkRow';

const group = (i: number, replaces: string | null) => ({
  groupId: `g${i}`,
  groupIndex: i,
  options: [`Fact ${i}`, `Alt ${i}`],
  questionnaireAttribute: 'profession: job role and industry',
  topicSkillId: null,
  replaces,
});

beforeEach(() => jest.clearAllMocks());

describe('two or more replace cards', () => {
  const draw = () =>
    render(<FactChoiceBulkRow resultKey="m1::0" baseResult={{}} groups={[group(0, 'w1'), group(1, 'w2')]} />);

  it('shows Replace all, Keep all and Skip all, and no Add all', () => {
    const { getByTestId, queryByTestId } = draw();
    expect(getByTestId('fact-choice-replace-all')).toBeTruthy();
    expect(getByTestId('fact-choice-keep-all')).toBeTruthy();
    expect(getByTestId('fact-choice-skip-all')).toBeTruthy();
    expect(queryByTestId('fact-choice-add-all')).toBeNull();
  });

  it('Replace all replaces each old fact (and so its topics) with the preferred reading', async () => {
    const { getByTestId } = draw();
    await act(async () => { fireEvent.press(getByTestId('fact-choice-replace-all')); });
    expect(mockCommit).toHaveBeenCalledWith([
      expect.objectContaining({ statement: 'Fact 0', replaces: 'w1' }),
      expect.objectContaining({ statement: 'Fact 1', replaces: 'w2' }),
    ]);
    const [, entries] = mockResolveGroups.mock.calls[0];
    expect(entries.map((e: { resolution: { status: string } }) => e.resolution.status)).toEqual(['saved', 'saved']);
  });

  it('Keep all adds every reading and replaces nothing', async () => {
    const { getByTestId } = draw();
    await act(async () => { fireEvent.press(getByTestId('fact-choice-keep-all')); });
    const [choices] = mockCommit.mock.calls[0] as unknown as [Record<string, unknown>[]];
    expect(choices.map((c) => c.statement)).toEqual(['Fact 0', 'Fact 1']);
    expect(choices.every((c) => !('replaces' in c))).toBe(true);
  });

  it('Skip all dismisses every card and writes nothing', async () => {
    const { getByTestId } = draw();
    await act(async () => { fireEvent.press(getByTestId('fact-choice-skip-all')); });
    expect(mockCommit).not.toHaveBeenCalled();
    const [, entries] = mockResolveGroups.mock.calls[0];
    expect(entries.map((e: { resolution: { status: string } }) => e.resolution.status)).toEqual(['dismissed', 'dismissed']);
  });
});

describe('a mixed turn: one add card and one replace card', () => {
  it('Replace all replaces the replace card and adds the add card', async () => {
    const { getByTestId } = render(
      <FactChoiceBulkRow resultKey="m1::0" baseResult={{}} groups={[group(0, null), group(1, 'w2')]} />,
    );
    await act(async () => { fireEvent.press(getByTestId('fact-choice-replace-all')); });
    const [choices] = mockCommit.mock.calls[0] as unknown as [Record<string, unknown>[]];
    expect(choices[0]).not.toHaveProperty('replaces');
    expect(choices[1]).toMatchObject({ replaces: 'w2' });
  });
});

describe('add cards only', () => {
  it('keeps Add all and Skip all', () => {
    const { getByTestId, queryByTestId } = render(
      <FactChoiceBulkRow resultKey="m1::0" baseResult={{}} groups={[group(0, null), group(1, null)]} />,
    );
    expect(getByTestId('fact-choice-add-all')).toBeTruthy();
    expect(queryByTestId('fact-choice-replace-all')).toBeNull();
  });
});
