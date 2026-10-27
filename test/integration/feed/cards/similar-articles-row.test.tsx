// The "N similar articles" row on the Feed card and the compact row: shown for a count, kept at its
// height (label hidden) at 0, named in the card root's spoken label, and never a tap target.
import { render } from '@testing-library/react-native';
import React from 'react';
import ArticleCardBase from '@/components/custom/cards/ArticleCardBase';
import ArticleCompactCardBase from '@/components/custom/cards/ArticleCompactCardBase';
import { initI18nEn } from '@/test/helpers';

jest.mock('react-native-reanimated', () => {
  const { View } = require('react-native');
  const { useRef } = require('react');
  return {
    __esModule: true,
    default: { View },
    Easing: require('react-native').Easing,
    useSharedValue: (v: unknown) => useRef({ value: v }).current,
    useAnimatedStyle: (fn: () => unknown) => fn(),
    useReducedMotion: () => false,
    cancelAnimation: () => {},
    withRepeat: (v: unknown) => v,
    withTiming: (v: unknown) => v,
    withSpring: (v: unknown) => v,
    withSequence: (v: unknown) => v,
    withDelay: (_d: unknown, v: unknown) => v,
    interpolate: () => 0,
    runOnJS: (f: unknown) => f,
  };
});

beforeAll(initI18nEn);

const CARD = { titleEnglish: 'Cabinet falls after the budget vote', publicationName: 'Harbour Daily' };

describe('feed card', () => {
  it('draws the row under the footer and speaks the count on the root', () => {
    const { getByTestId, getByText, getByLabelText } = render(
      <ArticleCardBase {...CARD} testID="card-a" footer={<></>} similarCount={3} />,
    );
    expect(getByTestId('card-similar-articles')).toBeTruthy();
    expect(getByText('3 similar articles')).toBeTruthy();
    expect(getByLabelText(/3 similar articles/)).toBeTruthy();
  });

  it('at 0 keeps the row but hides its label from VoiceOver and the label', () => {
    const { getByTestId, queryByLabelText } = render(
      <ArticleCardBase {...CARD} testID="card-a" footer={<></>} similarCount={0} />,
    );
    expect(getByTestId('card-similar-articles')).toBeTruthy();
    expect(queryByLabelText(/similar article/)).toBeNull();
  });

  it('draws no row without a count', () => {
    const { queryByTestId } = render(<ArticleCardBase {...CARD} testID="card-a" footer={<></>} />);
    expect(queryByTestId('card-similar-articles')).toBeNull();
  });
});

describe('compact row', () => {
  it('adds the row under the existing one for one copy ("1 similar article")', () => {
    const { getByText, getByLabelText } = render(<ArticleCompactCardBase {...CARD} testID="card-b" similarCount={1} />);
    expect(getByText('1 similar article')).toBeTruthy();
    expect(getByLabelText(/1 similar article/)).toBeTruthy();
  });

  it('adds nothing for 0 or none', () => {
    const none = render(<ArticleCompactCardBase {...CARD} testID="card-b" />);
    const zero = render(<ArticleCompactCardBase {...CARD} testID="card-c" similarCount={0} />);
    expect(none.queryByTestId('card-similar-articles')).toBeNull();
    expect(zero.queryByTestId('card-similar-articles')).toBeNull();
  });
});
