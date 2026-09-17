// ask_choice chips: an offer, not a gate.

/* eslint-disable @typescript-eslint/no-require-imports */
import React from 'react';
import { fireEvent, render } from '@testing-library/react-native';

jest.mock('react-i18next', () => ({ useTranslation: () => ({ t: (k: string) => k }) }));
jest.mock('@/components/ui/text', () => {
  const { Text } = require('react-native');
  return { Text };
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
jest.mock('@/lib/haptics', () => ({ hapticLight: jest.fn() }));

import AskChoiceCard from '../AskChoiceCard';

const OPTIONS = ['The district', 'The football club'];

describe('tapping a chip', () => {
  it('sends the option text VERBATIM through the thread send', () => {
    const onSend = jest.fn();
    const { getByTestId } = render(
      <AskChoiceCard question={null} options={OPTIONS} answered={false} onSend={onSend} />,
    );
    fireEvent.press(getByTestId('ask-choice-option-1'));
    // Verbatim matters: the loop matches the tap back to its option by text.
    expect(onSend).toHaveBeenCalledWith('The football club');
    expect(onSend).toHaveBeenCalledTimes(1);
  });

  it('does nothing once the offer is spent', () => {
    const onSend = jest.fn();
    const { getByTestId } = render(
      <AskChoiceCard question={null} options={OPTIONS} answered onSend={onSend} />,
    );
    fireEvent.press(getByTestId('ask-choice-option-0'));
    expect(onSend).not.toHaveBeenCalled();
  });
});

describe('the question', () => {
  it('renders when the bubble carried none', () => {
    const { getByText } = render(
      <AskChoiceCard
        question="Do you mean the district, or the club?"
        options={OPTIONS}
        answered={false}
        onSend={jest.fn()}
      />,
    );
    expect(getByText('Do you mean the district, or the club?')).toBeTruthy();
  });

  it('is absent when the deriver suppressed it, so it is never printed twice', () => {
    const { queryByText } = render(
      <AskChoiceCard question={null} options={OPTIONS} answered={false} onSend={jest.fn()} />,
    );
    expect(queryByText('Do you mean the district, or the club?')).toBeNull();
  });
});

describe('answered chips', () => {
  it('stay on screen, inert, so the thread keeps what was offered', () => {
    const { getByTestId } = render(
      <AskChoiceCard question={null} options={OPTIONS} answered onSend={jest.fn()} />,
    );
    const chip = getByTestId('ask-choice-option-0');
    expect(chip).toBeTruthy();
    expect(chip.props.accessibilityState.disabled).toBe(true);
    expect(chip.props.accessibilityLabel).toContain('askChoice.answeredA11y');
  });
});
