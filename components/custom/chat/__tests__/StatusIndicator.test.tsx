// The contract P4's facts row also depends on. The load-bearing case is the
// last one: an error must never render blank, and must never render a raw
// provider string, because the component has no way to be handed one.

/* eslint-disable @typescript-eslint/no-require-imports */
import React from 'react';
import { render } from '@testing-library/react-native';

// RN's own jest mock for ActivityIndicator calls requireActual, which reaches
// an untransformed `specs_DEPRECATED` file under this config and throws before
// any test body runs. Same class of problem as the reanimated mocks the
// StreamingIndicator suite carries. Must be declared BEFORE the import below.
// `jest.mock` is hoisted above the imports, so the factory must require its
// own React — closing over the imported one is an out-of-scope reference and
// fails the whole suite before any test runs.
jest.mock('react-native/Libraries/Components/ActivityIndicator/ActivityIndicator', () => {
  const R = require('react');
  const RN = require('react-native');
  return { __esModule: true, default: (p: any) => R.createElement(RN.View, p) };
});
jest.mock('@/components/ui/text', () => {
  const { Text } = require('react-native');
  return { Text };
});
// Render the icon as a View keyed by its GLYPH NAME. Asserting `icon-check`
// vs `icon-block` pins the actual glyph, which is stronger than a testID this
// component chooses for itself — and vector-icons does not forward testID
// under the jest mock anyway.
jest.mock('@expo/vector-icons', () => {
  const R = require('react');
  const RN = require('react-native');
  return {
    MaterialIcons: (p: any) => R.createElement(RN.View, { ...p, testID: `icon-${p.name}` }),
  };
});
jest.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => `t:${key}` }),
}));

import StatusIndicator from '../StatusIndicator';

describe('StatusIndicator', () => {
  it('spins while pending', () => {
    const { getByTestId, queryByTestId } = render(
      <StatusIndicator status="pending" label="Checking the area" testID="si" />,
    );
    expect(getByTestId('si-spinner')).toBeTruthy();
    expect(queryByTestId('icon-check')).toBeNull();
  });

  it('ticks when done, with no failure line', () => {
    const { getByTestId, queryByTestId } = render(
      <StatusIndicator status="done" label="Done" testID="si" />,
    );
    expect(getByTestId('icon-check')).toBeTruthy();
    expect(queryByTestId('si-consequence')).toBeNull();
  });

  it('shows the caller consequence on error', () => {
    const { getByTestId } = render(
      <StatusIndicator status="error" label="Checking the area" errorText="Mera used what it knew" testID="si" />,
    );
    expect(getByTestId('icon-block')).toBeTruthy();
    expect(getByTestId('si-consequence').props.children).toBe('Mera used what it knew');
  });

  it('NEVER renders a blank failure: no errorText falls back to a localised line', () => {
    const { getByTestId } = render(<StatusIndicator status="error" label="Step" testID="si" />);
    const line = getByTestId('si-consequence').props.children;
    expect(line).toBe('t:agentSteps.consequence.generic');
    expect(String(line).length).toBeGreaterThan(0);
  });

  it('puts the state in WORDS in the a11y label, not in colour alone', () => {
    const { getByTestId } = render(
      <StatusIndicator status="error" label="Checking the area" errorText="It did not finish" testID="si" />,
    );
    const label = getByTestId('si').props.accessibilityLabel;
    expect(label).toContain('Checking the area');
    expect(label).toContain('t:agentSteps.stateError');
    expect(label).toContain('It did not finish');
  });

  it('works with no label at all', () => {
    const { getByTestId } = render(<StatusIndicator status="done" testID="si" />);
    expect(getByTestId('si').props.accessibilityLabel).toBe('t:agentSteps.stateDone');
  });
});
