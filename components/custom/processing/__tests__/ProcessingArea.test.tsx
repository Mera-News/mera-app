// The processing area's surface, and the ZERO-ASSET PROOF.
//
// Every stage is rendered with `animation-registry.ts` mocked EMPTY, which is
// the configuration the module has to survive: an entry may exist there only
// once its file is on disk, so any subset from zero to six is a supported
// shipping state and a commented-out line must never blank the card.
//
// `jest.setup.js` does NOT mock react-native-reanimated — importing it throws
// on the uninitialised worklets native module, and the error points at the
// import line rather than at the cause. So this file carries its own, modelled
// on `AbstractGradientBackdrop.test.tsx`, which has the fullest one in the
// repo. `lottie-react-native` IS mocked globally, which is why only one of the
// two needs handling here.
/* eslint-disable @typescript-eslint/no-require-imports */

jest.mock('react-native-reanimated', () => {
  const { View } = require('react-native');
  return {
    __esModule: true,
    default: { View: (p: any) => <View {...p} /> },
    Easing: { inOut: (f: unknown) => f, ease: 'ease' },
    useAnimatedStyle: (fn: () => unknown) => fn(),
    useReducedMotion: () => false,
    // Per-instance identity, not a fresh object per render: the crossfade
    // writes this during an effect and reads it in the style, so a mock that
    // forgot the value between renders would make the assertions vacuous.
    useSharedValue: (initial: number) => {
      const { useRef } = require('react');
      return useRef({ value: initial }).current;
    },
    withRepeat: (v: unknown) => v,
    withTiming: (v: unknown) => v,
    cancelAnimation: () => undefined,
  };
});

// THE ZERO-ASSET PROOF. Empty on purpose.
jest.mock('../animation-registry', () => ({
  PROCESSING_ANIMATIONS: {},
  processingAnimationFor: () => undefined,
}));

// Resolves against the real en.json AND interpolates, because half the
// assertions below are about which NUMBERS reach the line. A mock that handed
// back the raw "{{ready}} of {{total}}" would pass every "contains a digit"
// check vacuously.
jest.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown> & { returnObjects?: boolean }) => {
      const en = require('@/lib/locales/en.json');
      const v = key.split('.').reduce<any>((acc, part) => acc?.[part], en);
      if (opts?.returnObjects) return v ?? [];
      if (typeof v !== 'string') return key;
      return v.replace(/\{\{(\w+)\}\}/g, (whole: string, name: string) =>
        opts && name in opts ? String(opts[name]) : whole,
      );
    },
  }),
}));

jest.mock('@/components/ui/text', () => {
  const { Text } = require('react-native');
  return { Text: (p: any) => <Text {...p} /> };
});

// Stubbed, not exercised: `MultiStepProgressBar` imports `components/ui/tooltip`,
// which pulls @legendapp/motion and through it RN internals jest cannot
// transform. It has its own suite (`__tests__/MultiStepProgressBar.test.tsx`)
// that mocks the same layer to test the bar itself, so duplicating that here
// would test the mocks rather than this component. The stub echoes back what it
// was asked to draw so the wiring is still asserted.
jest.mock('@/components/custom/MultiStepProgressBar', () => {
  const { View } = require('react-native');
  return {
    __esModule: true,
    default: (p: any) => <View testID="processing-stage-bar" {...p} />,
  };
});

import { render, screen } from '@testing-library/react-native';
import React from 'react';

import ProcessingArea from '../ProcessingArea';
import { bucketChunks } from '../ChunkStrip';
import { PROCESSING_STAGES } from '../processing-stages';
import {
  PROCESSING_CARD_HEIGHT,
  PROCESSING_CONTENT_HEIGHT,
  PROCESSING_METRICS,
  PROCESSING_STAGE_IDS,
  type ChunkState,
  type ProcessingSnapshot,
} from '../types';

const snap = (over: Partial<ProcessingSnapshot> = {}): ProcessingSnapshot => ({
  visible: true,
  stage: 'analysing',
  stageIndex: 3,
  stageValue: 40,
  chunks: [],
  chunksReady: 0,
  chunksTotal: 0,
  hydrationCompleted: 0,
  hydrationTotal: 0,
  analysedDone: 0,
  analysedTotal: 0,
  isStatic: false,
  animationsActive: true,
  ...over,
});

describe('the card is a fixed-height box, so the STACK has to fit it', () => {
  // A per-string size budget is not a layout budget and it will pass while the
  // layout overflows: the reading-stats share card shipped a per-locale line
  // count that stayed green while the rendered footer was pushed off the
  // canvas, in English. Every per-element assertion in this file was green at
  // 319pt of content inside a 300pt box with overflow: hidden, which clipped
  // about 10pt off the top of the scene and 10pt off the bottom of the Explore
  // button.
  //
  // This sums from the SAME object the component renders from. A test holding
  // its own copy of the spacing is the same trap wearing a different hat.
  it('fits, with room to spare', () => {
    expect(PROCESSING_CONTENT_HEIGHT).toBeLessThanOrEqual(PROCESSING_CARD_HEIGHT);
  });

  it('keeps a margin rather than sitting exactly on the boundary', () => {
    // A reserve grazed is a reserve breached the next time a token moves.
    expect(PROCESSING_CARD_HEIGHT - PROCESSING_CONTENT_HEIGHT).toBeGreaterThanOrEqual(8);
  });

  it('models every drawn row, so nothing can be added without appearing here', () => {
    expect(Object.keys(PROCESSING_METRICS).sort()).toEqual(
      [
        'barGap',
        'barHeight',
        'ctaGap',
        'ctaHeight',
        'headlineGap',
        'headlineLineHeight',
        'headlineLines',
        'labelGap',
        'labelLineHeight',
        'progressLineHeight',
        'sceneSize',
        'stripHeight',
      ].sort(),
    );
  });
});

describe('ProcessingArea — the zero-asset configuration', () => {
  it.each(PROCESSING_STAGE_IDS)(
    'draws a designed fallback for %s with no animation file on disk',
    (stage) => {
      render(<ProcessingArea snapshot={snap({ stage, stageIndex: 0 })} />);
      expect(screen.getByTestId(`processing-fallback-${stage}`)).toBeTruthy();
      expect(screen.queryByTestId(`processing-animation-${stage}`)).toBeNull();
    },
  );

  it.each(PROCESSING_STAGE_IDS)('names the stage %s rather than rendering a key', (stage) => {
    render(<ProcessingArea snapshot={snap({ stage })} />);
    const label = screen.getByTestId('processing-stage-label').props.children as string;
    expect(typeof label).toBe('string');
    expect(label).not.toContain('feed.processing');
    expect(label.length).toBeGreaterThan(0);
  });

  it('resolves a real headline for every stage, never a bare key', () => {
    for (const def of PROCESSING_STAGES) {
      render(<ProcessingArea snapshot={snap({ stage: def.id })} />);
      const line = screen.getByTestId('processing-headline').props.children as string;
      expect(line).not.toContain('feed.processing');
      expect(String(line).length).toBeGreaterThan(0);
      screen.unmount();
    }
  });
});

describe('ProcessingArea — the six-stage bar', () => {
  it('always draws six segments and points at the current stage', () => {
    render(<ProcessingArea snapshot={snap({ stage: 'summarising', stageIndex: 4, stageValue: 61 })} />);
    const bar = screen.getByTestId('processing-stage-bar');
    expect(bar.props.totalStages).toBe(6);
    expect(bar.props.currentStage).toBe(4);
    expect(bar.props.stageValue).toBe(61);
  });

  it('passes no stageNames: six labels under a card-width bar are unreadable', () => {
    render(<ProcessingArea snapshot={snap()} />);
    expect(screen.getByTestId('processing-stage-bar').props.stageNames).toBeUndefined();
  });
});

describe('ProcessingArea — the strip is NOT here', () => {
  // Two progress bars on one card read as one control drawn twice. The
  // six-stage bar stayed because it is the only element that says how far
  // through the run you are; the strip's counts are already on the progress
  // line in words. The strip itself still ships and is covered by
  // ChunkStrip.test.tsx, where FeedStatusPanel still renders it.
  it('draws no chunk strip, even with chunks in the snapshot', () => {
    const chunks: ChunkState[] = ['ready', 'failed', 'in-flight', 'queued'];
    render(<ProcessingArea snapshot={snap({ chunks, chunksReady: 1, chunksTotal: 4 })} />);
    expect(screen.queryByTestId('processing-chunk-strip')).toBeNull();
  });

  it('draws the six-stage bar and nothing else bar-shaped', () => {
    const chunks: ChunkState[] = ['ready', 'in-flight'];
    render(<ProcessingArea snapshot={snap({ chunks, chunksReady: 1, chunksTotal: 2 })} />);
    // The bar that survived.
    expect(screen.getAllByTestId('processing-stage-bar')).toHaveLength(1);
    // And no second run of segments beneath it.
    expect(screen.queryByTestId('processing-chunk-strip')).toBeNull();
  });
});

describe('bucketChunks', () => {
  it('passes a short run through untouched', () => {
    expect(bucketChunks(['ready', 'queued'], 24)).toEqual(['ready', 'queued']);
  });

  it('collapses a long run to exactly the cap, never wrapping to a second row', () => {
    const many: ChunkState[] = Array.from({ length: 97 }, () => 'ready');
    expect(bucketChunks(many, 24)).toHaveLength(24);
  });

  it('lets a problem survive the collapse: a bucket takes its WORST state', () => {
    // One failed chunk among ninety-five finished ones must still be visible,
    // or the strip hides the only thing worth looking at.
    const many: ChunkState[] = Array.from({ length: 96 }, () => 'ready');
    many[50] = 'failed';
    expect(bucketChunks(many, 24)).toContain('failed');
  });
});

describe('ProcessingArea — the static configuration', () => {
  // Reduce Motion, or the app's "Static background", which already defaults ON
  // below 6 GB of RAM. The scene freezes; the bar still updates,
  // because those are state changes rather than loops and progress is
  // information the reader needs whatever their motion preference is.
  it('still draws the stage and the progress line when static', () => {
    render(
      <ProcessingArea
        snapshot={snap({
          isStatic: true,
          chunks: ['ready', 'in-flight'],
          chunksReady: 1,
          chunksTotal: 2,
        })}
      />,
    );
    expect(screen.getByTestId('processing-stage-label')).toBeTruthy();
    expect(screen.getByTestId('processing-fallback-analysing')).toBeTruthy();
  });

  it('draws the same when blurred or backgrounded', () => {
    render(<ProcessingArea snapshot={snap({ animationsActive: false })} />);
    expect(screen.getByTestId('processing-area')).toBeTruthy();
  });
});

describe('ProcessingArea — the progress line never mixes two quantities', () => {
  it('shows downloaded ARTICLES while downloading', () => {
    render(
      <ProcessingArea
        snapshot={snap({
          stage: 'downloading',
          hydrationCompleted: 12,
          hydrationTotal: 40,
          chunks: ['queued'],
          chunksTotal: 1,
        })}
      />,
    );
    const line = String(screen.getByTestId('processing-progress-line').props.children);
    expect(line).toContain('12');
    expect(line).toContain('40');
  });

  it('shows analysed ARTICLES while analysing, not the batch count', () => {
    render(
      <ProcessingArea
        snapshot={snap({
          stage: 'analysing',
          analysedDone: 40,
          analysedTotal: 220,
          chunks: ['ready', 'in-flight'],
          chunksReady: 1,
          chunksTotal: 2,
        })}
      />,
    );
    const line = String(screen.getByTestId('processing-progress-line').props.children);
    // Both are true at this instant: 40 of 220 ARTICLES and 1 of 2 BATCHES. The
    // line must pick the one the stage is measuring, and it must not be the
    // batch sentence.
    expect(line).toBe('Analysing 40 of 220 articles');
    expect(line).not.toContain('batches');
  });

  it('falls back to the batch count only when no article count is known', () => {
    render(
      <ProcessingArea
        snapshot={snap({ stage: 'grouping', chunks: ['queued', 'queued'], chunksTotal: 2 })}
      />,
    );
    const line = String(screen.getByTestId('processing-progress-line').props.children);
    expect(line).toBe('0 of 2 analysis batches finished');
  });

  it('says nothing rather than inventing a number', () => {
    render(<ProcessingArea snapshot={snap({ stage: 'preparing' })} />);
    expect(String(screen.getByTestId('processing-progress-line').props.children)).toBe('');
  });

  it('puts the orphaned amber subline back on screen during fetching', () => {
    // Translated in all twenty locales and shown to nobody since
    // FeedStatusShimmer was deleted.
    render(<ProcessingArea snapshot={snap({ stage: 'fetching' })} />);
    const line = String(screen.getByTestId('processing-progress-line').props.children);
    expect(line).toBe('Please keep this screen open.');
  });
});
