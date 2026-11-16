// Processing copy: one honest count, no "nothing leaves it", no notify promise.
import { render, screen } from '@testing-library/react-native';
import React from 'react';
import ProcessingArea from '@/components/custom/processing/ProcessingArea';
import type { ProcessingSnapshot } from '@/components/custom/processing/types';
import { initI18nEn } from '@/test/helpers';

jest.mock('react-native-reanimated', () => {
  const { View, Text } = require('react-native');
  const R = require('react');
  return {
    __esModule: true,
    default: { View, Text },
    Easing: { bezier: () => () => 0, linear: () => 0, inOut: () => () => 0, out: () => () => 0, in: () => () => 0, ease: () => 0, cubic: () => 0 },
    useReducedMotion: () => true,
    useSharedValue: (v: unknown) => R.useRef({ value: v, set(n: unknown) { this.value = n; } }).current,
    useAnimatedStyle: () => ({}),
    withTiming: (v: unknown) => v,
    withRepeat: (v: unknown) => v,
    cancelAnimation: () => {},
  };
});
jest.mock('@/components/custom/processing/ProcessingStageAnimation', () => () => null);
jest.mock('@/components/custom/MultiStepProgressBar', () => () => null);

const snap = (over: Partial<ProcessingSnapshot>): ProcessingSnapshot => ({
  visible: true, stage: 'analysing', stageIndex: 3, stageValue: 30, chunks: [], chunksReady: 0, chunksTotal: 0,
  hydrationCompleted: 0, hydrationTotal: 0, analysedDone: 12, analysedTotal: 40, isStatic: true, animationsActive: false,
  ...over,
});

beforeAll(initI18nEn);

it('cloud analysing: the headline carries the count and the line below stays empty', async () => {
  await render(<ProcessingArea snapshot={snap({})} />);
  expect(screen.getByTestId('processing-headline').props.children).toBe('Reading 12 of 40 for you');
  expect(screen.getByTestId('processing-progress-line').props.children).toBe('');
});

it('summarising does not claim it is reading and shows one count', async () => {
  await render(<ProcessingArea snapshot={snap({ stage: 'summarising', stageIndex: 4 })} />);
  expect(screen.getByTestId('processing-headline').props.children).toBe('');
  expect(screen.getByTestId('processing-progress-line').props.children).toBe('Analysing 12 of 40 articles');
});

it('on device says it reads on the phone, with no nothing-leaves claim', async () => {
  await render(<ProcessingArea snapshot={snap({})} onDevice />);
  const head = screen.getByTestId('processing-headline').props.children as string;
  expect(head).toBe('Mera is reading the news on this phone.');
  expect(head).not.toMatch(/nothing leaves/i);
});

it('no stage promises a notification', async () => {
  const stages = ['fetching', 'downloading', 'grouping', 'analysing', 'summarising', 'preparing'] as const;
  for (const stage of stages) {
    const { unmount } = await render(<ProcessingArea snapshot={snap({ stage })} />);
    expect(JSON.stringify(screen.toJSON())).not.toMatch(/notify/i);
    unmount();
  }
});
