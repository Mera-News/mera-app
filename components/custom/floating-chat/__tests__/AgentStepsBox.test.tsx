/* eslint-disable @typescript-eslint/no-require-imports */
import React from 'react';
import { act, render } from '@testing-library/react-native';

jest.mock('react-native/Libraries/Components/ActivityIndicator/ActivityIndicator', () => {
  const R = require('react');
  const RN = require('react-native');
  return { __esModule: true, default: (p: any) => R.createElement(RN.View, p) };
});
jest.mock('@/components/ui/text', () => {
  const { Text } = require('react-native');
  return { Text };
});
jest.mock('@expo/vector-icons', () => {
  const R = require('react');
  const RN = require('react-native');
  return {
    MaterialIcons: (p: any) => R.createElement(RN.View, { ...p, testID: `icon-${p.name}` }),
  };
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
jest.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) =>
      opts ? `t:${key}:${JSON.stringify(opts)}` : `t:${key}`,
  }),
}));

const mockAnimationsActive = jest.fn(() => true);
jest.mock('@/lib/hooks/use-is-focused-safe', () => ({
  useAnimationsActive: () => mockAnimationsActive(),
}));

import AgentStepsBox, { SLOW_STEP_MS } from '../AgentStepsBox';
import type { AgentStep } from '../types';

const step = (over: Partial<AgentStep> = {}): AgentStep => ({
  id: 's1',
  kind: 'tool',
  toolName: 'lookup_place',
  labelKey: 'agentSteps.lookupPlace',
  status: 'pending',
  ...over,
});

const props = (over: Partial<React.ComponentProps<typeof AgentStepsBox>> = {}) => ({
  steps: [step()],
  collapsed: false,
  doneCount: 0,
  failedCount: 0,
  legCapped: false,
  interrupted: false,
  ...over,
});

beforeEach(() => {
  mockAnimationsActive.mockReturnValue(true);
});

describe('expanded', () => {
  it('renders one row per step', () => {
    const { getByTestId } = render(
      <AgentStepsBox
        {...props({
          steps: [
            step({ id: 'a', status: 'done', labelKey: 'agentSteps.findSimilarFacts' }),
            step({ id: 'b', status: 'pending' }),
          ],
        })}
      />,
    );
    expect(getByTestId('agent-step-a')).toBeTruthy();
    expect(getByTestId('agent-step-b')).toBeTruthy();
  });

  it('resolves a skill phrase through a NESTED lookup, never printing the id', () => {
    const { getByTestId } = render(
      <AgentStepsBox
        {...props({
          steps: [
            step({
              id: 'a',
              status: 'done',
              toolName: 'load_skill',
              labelKey: 'agentSteps.loadSkill',
              labelValues: { topicKey: 'skillPhrase.residence' },
            }),
          ],
        })}
      />,
    );
    const label = getByTestId('agent-step-a').props.accessibilityLabel;
    expect(label).toContain('t:skillPhrase.residence');
    expect(label).not.toContain('facts/residence');
  });

  it('shows a consequence under a failed row, never a bare failure', () => {
    const { getByTestId } = render(
      <AgentStepsBox
        {...props({
          steps: [
            step({ id: 'a', status: 'error', consequenceKey: 'agentSteps.consequence.lookupPlace' }),
          ],
          failedCount: 1,
        })}
      />,
    );
    expect(getByTestId('agent-step-a-consequence').props.children).toBe(
      't:agentSteps.consequence.lookupPlace',
    );
  });
});

describe('the slow line', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('appears after SLOW_STEP_MS and changes NO status', () => {
    const { queryByTestId, getByTestId } = render(<AgentStepsBox {...props()} />);
    expect(queryByTestId('agent-steps-slow')).toBeNull();

    act(() => {
      jest.advanceTimersByTime(SLOW_STEP_MS + 10);
    });

    expect(getByTestId('agent-steps-slow')).toBeTruthy();
    // Still pending: the line is additive, never a failure and never a retry.
    expect(getByTestId('agent-step-s1-spinner')).toBeTruthy();
  });

  it('NEVER appears on an interrupted box, however long you wait', () => {
    // The spinner and the slow line are both reachable only from `pending`,
    // and an interrupted box has no pending row. This is the assertion that
    // proves the eternal spinner is gone, rather than merely unrendered once.
    const { queryByTestId } = render(
      <AgentStepsBox
        {...props({
          steps: [
            step({ id: 'a', status: 'error', consequenceKey: 'agentSteps.consequence.interrupted' }),
          ],
          interrupted: true,
          failedCount: 1,
        })}
      />,
    );
    act(() => {
      jest.advanceTimersByTime(SLOW_STEP_MS * 5);
    });
    expect(queryByTestId('agent-steps-slow')).toBeNull();
    expect(queryByTestId('agent-step-a-spinner')).toBeNull();
  });
});

describe('collapsed', () => {
  it('renders one summary row and no step rows', () => {
    const { getByTestId, queryByTestId } = render(
      <AgentStepsBox
        {...props({ steps: [step({ id: 'a', status: 'done' })], collapsed: true, doneCount: 3 })}
      />,
    );
    expect(getByTestId('agent-steps-summary')).toBeTruthy();
    expect(queryByTestId('agent-step-a')).toBeNull();
  });

  it('says one thing did not work when something failed', () => {
    const { getByTestId } = render(
      <AgentStepsBox {...props({ collapsed: true, failedCount: 1, doneCount: 2 })} />,
    );
    expect(getByTestId('agent-steps-summary').props.accessibilityLabel).toContain(
      't:agentSteps.summaryOneFailed',
    );
  });

  it('renders the leg-cap sentence when the bound was hit', () => {
    const { getByTestId } = render(
      <AgentStepsBox {...props({ collapsed: true, legCapped: true, doneCount: 4 })} />,
    );
    expect(getByTestId('agent-steps-summary').props.accessibilityLabel).toContain(
      't:agentSteps.legCapSentence',
    );
  });

  it('renders the interrupted sentence', () => {
    const { getByTestId } = render(
      <AgentStepsBox {...props({ collapsed: true, interrupted: true, failedCount: 1 })} />,
    );
    expect(getByTestId('agent-steps-summary').props.accessibilityLabel).toContain(
      't:agentSteps.interrupted',
    );
  });
});

describe('accessibility and motion', () => {
  it('is one polite live region for the whole box', () => {
    const { getByTestId } = render(<AgentStepsBox {...props()} />);
    expect(getByTestId('agent-steps').props.accessibilityLiveRegion).toBe('polite');
  });

  it('drops the entering animation when animations are inactive', () => {
    mockAnimationsActive.mockReturnValue(false);
    const { getByTestId } = render(<AgentStepsBox {...props()} />);
    expect(getByTestId('agent-steps').props.entering).toBeUndefined();
  });

  it('keeps the entering animation when they are active', () => {
    const { getByTestId } = render(<AgentStepsBox {...props()} />);
    expect(getByTestId('agent-steps').props.entering).toBeDefined();
  });

  it('keeps the pending SPINNER regardless of the animation gate', () => {
    // use-is-focused-safe's docstring: never gate an in-flight liveness signal
    // on that hook, because a paused one reads as a hung request.
    mockAnimationsActive.mockReturnValue(false);
    const { getByTestId } = render(<AgentStepsBox {...props()} />);
    expect(getByTestId('agent-step-s1-spinner')).toBeTruthy();
  });
});
