// ChunkStrip — per-batch state, one segment each.
//
// These specs used to live in ProcessingArea.test.tsx, because the strip used
// to render inside the processing card under the six-stage bar. It no longer
// does: two progress bars stacked on one card read as one control drawn twice,
// and the strip lost that argument because its counts are already stated in
// words on the progress line while the bar is the only element saying how far
// through the whole run you are.
//
// The component still ships. FeedStatusPanel renders it, and there it is the
// only progress element on the surface, so its one unique signal (a failed
// batch sitting behind ready ones, which a linear bar cannot express) has room
// to be read. The tests moved here rather than being deleted with the call
// site, so that coverage follows the component instead of the screen.
/* eslint-disable @typescript-eslint/no-require-imports */

jest.mock('react-native-reanimated', () => {
    const { View } = require('react-native');
    return {
        __esModule: true,
        default: { View: (p: any) => <View {...p} /> },
        Easing: { inOut: (f: unknown) => f, ease: 'ease' },
        useAnimatedStyle: (fn: () => unknown) => fn(),
        useReducedMotion: () => false,
        useSharedValue: (initial: number) => {
            const { useRef } = require('react');
            return useRef({ value: initial }).current;
        },
        withRepeat: (v: unknown) => v,
        withTiming: (v: unknown) => v,
        cancelAnimation: () => undefined,
    };
});

jest.mock('react-i18next', () => ({
    useTranslation: () => ({ t: (key: string) => key }),
}));

import { render, screen } from '@testing-library/react-native';
import React from 'react';
import ChunkStrip from '../ChunkStrip';
import type { ChunkState } from '../types';

describe('ChunkStrip', () => {
    it('draws one segment per chunk, in run order', () => {
        const chunks: ChunkState[] = ['ready', 'failed', 'in-flight', 'queued'];
        render(<ChunkStrip chunks={chunks} ready={1} total={4} active />);
        expect(screen.getByTestId('processing-chunk-strip')).toBeTruthy();
        expect(screen.getAllByTestId('processing-chunk-ready')).toHaveLength(1);
        expect(screen.getAllByTestId('processing-chunk-failed')).toHaveLength(1);
        expect(screen.getAllByTestId('processing-chunk-in-flight')).toHaveLength(1);
        expect(screen.getAllByTestId('processing-chunk-queued')).toHaveLength(1);
    });

    it('draws every chunk ready', () => {
        const chunks: ChunkState[] = ['ready', 'ready', 'ready'];
        render(<ChunkStrip chunks={chunks} ready={3} total={3} active />);
        expect(screen.getAllByTestId('processing-chunk-ready')).toHaveLength(3);
    });

    it('still draws when motion is off, because a state change is not a loop', () => {
        const chunks: ChunkState[] = ['ready', 'in-flight'];
        render(<ChunkStrip chunks={chunks} ready={1} total={2} active={false} />);
        expect(screen.getByTestId('processing-chunk-strip')).toBeTruthy();
        expect(screen.getAllByTestId('processing-chunk-ready')).toHaveLength(1);
    });
});
