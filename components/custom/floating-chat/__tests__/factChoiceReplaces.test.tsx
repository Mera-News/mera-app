// The replacement disclosure. A `replaces` group destroys a fact and every
// topic it owns, in one transaction, with no inverse — so the whole point of
// this suite is that the accept cannot be tapped before the card can say what
// disappears.

/* eslint-disable @typescript-eslint/no-require-imports */
import React from 'react';
import { act, fireEvent, render } from '@testing-library/react-native';

jest.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (k: string, o?: Record<string, unknown>) => (o ? `${k}:${JSON.stringify(o)}` : k),
  }),
}));
jest.mock('@/components/ui/text', () => {
  const { Text } = require('react-native');
  return { Text };
});
jest.mock('@/components/ui/button', () => {
  const R = require('react');
  const RN = require('react-native');
  return {
    Button: (p: any) =>
      R.createElement(
        RN.Pressable,
        { ...p, disabled: p.isDisabled, accessibilityState: { disabled: !!p.isDisabled } },
        p.children,
      ),
    ButtonText: (p: any) => R.createElement(RN.Text, null, p.children),
  };
});
jest.mock('@expo/vector-icons', () => {
  const R = require('react');
  const RN = require('react-native');
  return { MaterialIcons: (p: any) => R.createElement(RN.View, { ...p, testID: `icon-${p.name}` }) };
});
jest.mock('react-native-reanimated', () => {
  const R = require('react');
  const RN = require('react-native');
  return {
    __esModule: true,
    default: { View: (p: any) => R.createElement(RN.View, p) },
    withTiming: (v: unknown) => v,
  };
});
jest.mock('@/components/custom/TranslatableDynamic', () => {
  const R = require('react');
  const RN = require('react-native');
  return { __esModule: true, default: (p: any) => R.createElement(RN.Text, null, p.text) };
});
jest.mock('@/lib/haptics', () => ({ hapticLight: jest.fn(), hapticSuccess: jest.fn() }));
jest.mock('@/lib/logger', () => ({ __esModule: true, default: { error: jest.fn() } }));

const mockCommit = jest.fn(async () => ({ savedFacts: [{ id: 'new', statement: 's' }], conflicts: [] }));
jest.mock('@/lib/chat-tools/fact-commit', () => ({
  commitFactChoices: (...a: unknown[]) => mockCommit(...(a as [])),
}));
jest.mock('../fact-choice-actions', () => ({ resolveGroup: jest.fn() }));

let mockFacts: { id: string; statement: string; questionnaireAttribute?: string }[] = [];
let mockTopics: { id: string; status: string }[] = [];
let mockFactsThrows = false;
jest.mock('@/lib/database/services/fact-service', () => ({
  getFacts: async () => {
    if (mockFactsThrows) throw new Error('db down');
    return mockFacts;
  },
}));
jest.mock('@/lib/database/services/topic-service', () => ({
  getByFact: async () => mockTopics,
}));

import { FactChoiceCard } from '../FactChoiceCard';

const props = {
  resultKey: 'm1::0',
  baseResult: {},
  groupIndex: 0,
  groupId: 'g0',
  options: ['I live in Nieuw-West, Amsterdam'],
  questionnaireAttribute: null,
};

const drawReplace = () =>
  render(<FactChoiceCard {...props} replacesFactId="old-1" />);

beforeEach(() => {
  jest.clearAllMocks();
  mockFactsThrows = false;
  mockFacts = [{ id: 'old-1', statement: 'Lives in Amsterdam' }];
  mockTopics = Array.from({ length: 8 }, (_, i) => ({ id: `t${i}`, status: 'active' }));
});

describe('before the disclosure resolves', () => {
  it('DISABLES the accept, so a fast tap cannot destroy an unnamed fact', () => {
    const { getByTestId } = drawReplace();
    expect(getByTestId('fact-choice-add-0').props.accessibilityState.disabled).toBe(true);
  });

  it('presses through to nothing while disabled', async () => {
    const { getByTestId } = drawReplace();
    await act(async () => {
      fireEvent.press(getByTestId('fact-choice-add-0'));
    });
    expect(mockCommit).not.toHaveBeenCalled();
  });
});

describe('once it resolves', () => {
  it('names the fact and the topic count, and says there is no undo', async () => {
    const { getByTestId, findByText } = drawReplace();
    expect(await findByText('Lives in Amsterdam')).toBeTruthy();
    expect(getByTestId('fact-choice-replaces-0')).toBeTruthy();
    expect(await findByText('factChoice.replacesTopics:{"count":8}')).toBeTruthy();
    expect(await findByText('factChoice.replacesNoUndo')).toBeTruthy();
  });

  it('enables the accept and labels it Replace, never Add', async () => {
    const { getByTestId, findByText } = drawReplace();
    await findByText('Lives in Amsterdam');
    expect(getByTestId('fact-choice-add-0').props.accessibilityState.disabled).toBe(false);
    expect(await findByText('factChoice.replace')).toBeTruthy();
  });

  it('commits with `replaces`, so one transaction replaces rather than adds', async () => {
    const { getByTestId, findByText } = drawReplace();
    await findByText('Lives in Amsterdam');
    await act(async () => {
      fireEvent.press(getByTestId('fact-choice-add-0'));
    });
    expect(mockCommit).toHaveBeenCalledWith([
      expect.objectContaining({ replaces: 'old-1' }),
    ]);
  });

  it('counts only ACTIVE topics', async () => {
    mockTopics = [
      { id: 'a', status: 'active' },
      { id: 'b', status: 'retired' },
    ];
    const { findByText } = drawReplace();
    expect(await findByText('factChoice.replacesTopics:{"count":1}')).toBeTruthy();
  });
});

describe('when the lookup fails', () => {
  it('KEEPS the accept disabled rather than falling back to a plain Add', async () => {
    // Falling back would write a duplicate AND leave the old fact standing:
    // a silent wrong outcome instead of a visible blocked one.
    mockFactsThrows = true;
    const { getByTestId, findByText } = drawReplace();
    expect(await findByText('factChoice.replacesUnavailable')).toBeTruthy();
    expect(getByTestId('fact-choice-add-0').props.accessibilityState.disabled).toBe(true);
  });

  it('says so when the target fact is already gone', async () => {
    mockFacts = [];
    const { getByTestId, findByText } = drawReplace();
    expect(await findByText('factChoice.replacesUnavailable')).toBeTruthy();
    expect(getByTestId('fact-choice-add-0').props.accessibilityState.disabled).toBe(true);
  });

  it('Skip still works throughout', async () => {
    mockFactsThrows = true;
    const { getByTestId, findByText } = drawReplace();
    await findByText('factChoice.replacesUnavailable');
    const { resolveGroup } = require('../fact-choice-actions');
    await act(async () => {
      fireEvent.press(getByTestId('fact-choice-dismiss-0'));
    });
    expect(resolveGroup).toHaveBeenCalled();
  });
});

describe('an ordinary ADD group is untouched', () => {
  it('shows no disclosure and an enabled Add', () => {
    const { getByTestId, queryByTestId, queryByText } = render(
      <FactChoiceCard {...props} replacesFactId={null} />,
    );
    expect(queryByTestId('fact-choice-replaces-0')).toBeNull();
    expect(queryByText('factChoice.replacesNoUndo')).toBeNull();
    expect(getByTestId('fact-choice-add-0').props.accessibilityState.disabled).toBe(false);
  });
});

// ===========================================================================
// N17: "Keep both", offered only when both facts can be true at once.
// ===========================================================================
describe('Keep both', () => {
  const HOME = 'location: neighborhood/area, city, and country (preserve specifics)';
  const ORIGIN = 'background: country of origin';

  it('is offered, and leads, when the two facts sit under different keys', async () => {
    // Not a home fact: a home fact is never replaced by another key at all
    // (see the home-key guard below), so it never reaches this choice.
    mockFacts = [{ id: 'old-1', statement: 'Product manager', questionnaireAttribute: 'profession: job role and industry' }];
    const { getByTestId, findByText } = render(
      <FactChoiceCard {...props} options={['Works at Zalando']} questionnaireAttribute="company: employer name" replacesFactId="old-1" />,
    );
    expect(await findByText('factChoice.titleAlsoAdd')).toBeTruthy();
    expect(getByTestId('fact-choice-keep-both-0')).toBeTruthy();
    await act(async () => {
      fireEvent.press(getByTestId('fact-choice-keep-both-0'));
    });
    // A plain add: the old fact and its topics stay.
    expect(mockCommit).toHaveBeenCalledWith([
      expect.not.objectContaining({ replaces: expect.anything() }),
    ]);
  });

  it('is not offered for a true contradiction under the same key', async () => {
    mockFacts = [{ id: 'old-1', statement: 'Lives in Amsterdam', questionnaireAttribute: HOME }];
    const { queryByTestId, findByText } = render(
      <FactChoiceCard {...props} options={['Lives in Berlin']} questionnaireAttribute={HOME} replacesFactId="old-1" />,
    );
    expect(await findByText('factChoice.titleReplace')).toBeTruthy();
    expect(queryByTestId('fact-choice-keep-both-0')).toBeNull();
  });

  // ux1 C4: the reply said "I can keep both" above a card that could not.
  it('IS offered when the old fact is a combined origin-and-home one', async () => {
    mockFacts = [{ id: 'old-1', statement: 'Expat from India living in Amsterdam', questionnaireAttribute: 'background: origin and current residence' }];
    const { getByTestId, findByText } = render(
      <FactChoiceCard {...props} options={['Originally from India']} questionnaireAttribute={ORIGIN} replacesFactId="old-1" />,
    );
    expect(await findByText('factChoice.titleAlsoAdd')).toBeTruthy();
    expect(getByTestId('fact-choice-keep-both-0')).toBeTruthy();
  });

  it('is not offered before the card can name the fact it would keep', () => {
    mockFacts = [{ id: 'old-1', statement: 'Product manager', questionnaireAttribute: 'profession: job role and industry' }];
    const { queryByTestId } = render(
      <FactChoiceCard {...props} options={['Works at Zalando']} questionnaireAttribute="company: employer name" replacesFactId="old-1" />,
    );
    expect(queryByTestId('fact-choice-keep-both-0')).toBeNull();
  });
});

// A home fact is only ever replaced by a home fact, on EVERY engine. The loop
// enforces it for the cloud path; the card enforces it for whatever staged the
// group, including the on-device path, which has no loop.
describe('the home-key guard on the card', () => {
  const HOME = 'location: neighborhood/area, city, and country (preserve specifics)';

  it('turns a non-home fact targeting a home fact into a plain add', async () => {
    mockFacts = [{ id: 'old-1', statement: 'Lives in Nieuw-West, Amsterdam', questionnaireAttribute: HOME }];
    const { getByTestId, findByText, queryByTestId } = render(
      <FactChoiceCard
        {...props}
        options={['Expat from India living in Amsterdam']}
        questionnaireAttribute="background: origin and current residence"
        replacesFactId="old-1"
      />,
    );
    expect(await findByText('factChoice.titleSingle')).toBeTruthy();
    expect(queryByTestId('fact-choice-replaces-0')).toBeNull();
    await act(async () => {
      fireEvent.press(getByTestId('fact-choice-add-0'));
    });
    expect(mockCommit).toHaveBeenCalledWith([
      expect.not.objectContaining({ replaces: expect.anything() }),
    ]);
  });
});
