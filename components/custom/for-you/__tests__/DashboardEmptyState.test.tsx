/* eslint-disable @typescript-eslint/no-require-imports */
// S11: the Dashboard's empty state was a useCallback handed to the list as a
// component TYPE, so any input change remounted the whole card.
import fs from 'fs';
import path from 'path';

let mockMounts = 0;
jest.mock('react-i18next', () => ({ useTranslation: () => ({ t: (k: string) => k }) }));
jest.mock('@/components/custom/processing/FeedProcessingCard', () => {
  const React = require('react');
  const { View } = require('react-native');
  return {
    __esModule: true,
    default: () => {
      React.useEffect(() => {
        mockMounts += 1;
      }, []);
      return <View testID="processing-card" />;
    },
  };
});
jest.mock('@/components/custom/AllCaughtUpCard', () => {
  const { View } = require('react-native');
  return { __esModule: true, default: () => <View testID="caught-up" /> };
});
jest.mock('@/components/custom/DailyLimitCard', () => {
  const { View } = require('react-native');
  return { __esModule: true, default: () => <View testID="daily-limit" /> };
});
jest.mock('@/components/custom/NoGeneratedInterestsCard', () => {
  const { View } = require('react-native');
  return { __esModule: true, default: () => <View testID="no-interests" /> };
});
jest.mock('@/components/custom/for-you/OnboardingWaitingCard', () => {
  const { View } = require('react-native');
  return { __esModule: true, default: () => <View testID="onboarding-wait" /> };
});
jest.mock('@/components/ui/spinner', () => ({ Spinner: () => null }));
jest.mock('@/components/ui/icon', () => ({ Icon: () => null, AlertCircleIcon: () => null }));
jest.mock('@/components/ui/text', () => {
  const { Text } = require('react-native');
  return { Text: (p: any) => <Text {...p} /> };
});
jest.mock('@/components/ui/box', () => {
  const { View } = require('react-native');
  return { Box: (p: any) => <View {...p} /> };
});

import { render, screen } from '@testing-library/react-native';
import React from 'react';
import { View } from 'react-native';
import DashboardEmptyState, { type DashboardEmptyStateProps } from '../DashboardEmptyState';

const base: DashboardEmptyStateProps = {
  showOnboardingWait: false,
  isLoading: false,
  stuckOnEmpty: false,
  errorMessage: null,
  hasGeneratedInterests: true,
  statusMode: 'idle' as any,
  isFeedProcessing: true,
  lastProcessingRunFinishedAt: null,
};

// A stand-in for a list slot that accepts either an element or a component
// type, the way ListEmptyComponent does.
const Slot = ({ empty }: { empty: React.ReactElement | React.ComponentType }) => {
  const E = empty as React.ComponentType;
  return <View>{React.isValidElement(empty) ? empty : <E />}</View>;
};
const inList = (props: DashboardEmptyStateProps) => <Slot empty={<DashboardEmptyState {...props} />} />;
// The old shape: a fresh component type per render.
const asType = (props: DashboardEmptyStateProps) => (
  <Slot empty={() => <DashboardEmptyState {...props} />} />
);

beforeEach(() => {
  mockMounts = 0;
});

describe('DashboardEmptyState', () => {
  it('keeps the processing card mounted when an unrelated input changes', () => {
    const { rerender } = render(inList(base));
    rerender(inList({ ...base, lastProcessingRunFinishedAt: 1234 }));
    rerender(inList({ ...base, lastProcessingRunFinishedAt: 5678, errorMessage: '' }));
    expect(screen.getByTestId('processing-card')).toBeTruthy();
    expect(mockMounts).toBe(1);
  });

  it('THE CONTROL: a fresh component type per render does remount', () => {
    const { rerender } = render(asType(base));
    rerender(asType({ ...base, lastProcessingRunFinishedAt: 1234 }));
    expect(mockMounts).toBe(2);
  });

  it('shows caught-up once a run has finished and nothing is processing', () => {
    render(<DashboardEmptyState {...base} isFeedProcessing={false} lastProcessingRunFinishedAt={1} />);
    expect(screen.getByTestId('caught-up')).toBeTruthy();
  });

  it('puts the daily limit ahead of the processing card', () => {
    render(<DashboardEmptyState {...base} statusMode={'limited' as any} />);
    expect(screen.getByTestId('daily-limit')).toBeTruthy();
  });

  it('ForYouScreen passes an element, never a render callback', () => {
    const src = fs.readFileSync(path.resolve(__dirname, '../ForYouScreen.tsx'), 'utf8');
    expect(src).not.toMatch(/ListEmptyComponent=\{renderEmpty\}/);
    expect(src).toMatch(/<DashboardEmptyState/);
  });
});
