// IdleScene — the calm idle loop, drawn by both empty states that are WAITING
// rather than reporting a problem.
//
// These specs exist because the scene was briefly inlined twice, once in
// AllCaughtUpCard and once in FeedProcessingCard's fallback branch. Two copies
// of the same twelve lines is how the two drift: one gains a gate the other
// does not, and the difference only shows on the devices nobody tests.
/* eslint-disable @typescript-eslint/no-require-imports */

let mockReduceMotion = false;
jest.mock('react-native-reanimated', () => ({
    __esModule: true,
    useReducedMotion: () => mockReduceMotion,
}));

let mockStaticGradient = false;
jest.mock('@/lib/stores/display-prefs-store', () => ({
    useDisplayPrefsStore: (sel: any) => sel({ staticGradient: mockStaticGradient }),
}));

let mockAnimationsActive = true;
jest.mock('@/lib/hooks/use-is-focused-safe', () => ({
    useAnimationsActive: () => mockAnimationsActive,
}));

jest.mock('@/components/ui/box', () => {
    const { View } = require('react-native');
    return { Box: (p: any) => <View {...p} /> };
});

import { render, screen } from '@testing-library/react-native';
import React from 'react';
import IdleScene from '../IdleScene';
import { PROCESSING_SCENE_SIZE } from '@/components/custom/processing/types';

const lottieOf = (testID: string) => {
    const node = screen.getByTestId(testID);
    return node.props.children;
};

describe('IdleScene', () => {
    beforeEach(() => {
        mockReduceMotion = false;
        mockStaticGradient = false;
        mockAnimationsActive = true;
    });

    it('draws at the size the processing card draws its stage scene', () => {
        // Not a style choice. These surfaces swap as a run starts and ends, so a
        // different number makes the artwork jump, which reads as the card
        // breaking rather than as work beginning.
        render(<IdleScene testID="scene" />);
        expect(screen.getByTestId('scene').props.style).toEqual(
            expect.objectContaining({
                width: PROCESSING_SCENE_SIZE,
                height: PROCESSING_SCENE_SIZE,
            }),
        );
    });

    it('plays when nothing suppresses it', () => {
        render(<IdleScene testID="scene" />);
        expect(lottieOf('scene').props.autoPlay).toBe(true);
        expect(lottieOf('scene').props.progress).toBeUndefined();
    });

    it.each([
        ['Reduce Motion', () => { mockReduceMotion = true; }],
        ['the static-background preference', () => { mockStaticGradient = true; }],
        ['nobody looking at the screen', () => { mockAnimationsActive = false; }],
    ])('holds frame 0 rather than an empty box under %s', (_label, set) => {
        // staticGradient defaults ON below 6 GB of RAM, so the frozen frame is
        // the NORMAL rendering on a large share of the fleet, not a rare
        // degradation. game-hud-idle is authored with both layers lit at frame 0
        // for exactly this reason.
        set();
        render(<IdleScene testID="scene" />);
        expect(lottieOf('scene').props.autoPlay).toBe(false);
        expect(lottieOf('scene').props.progress).toBe(0);
    });

    it('takes its testID from the caller, so two surfaces cannot collide', () => {
        // A shared id returns the first match, which lets an assertion pass
        // against the wrong surface entirely.
        const { unmount } = render(<IdleScene testID="all-caught-up-idle-scene" />);
        expect(screen.getByTestId('all-caught-up-idle-scene')).toBeTruthy();
        unmount();
        render(<IdleScene testID="feed-preparing-idle-scene" />);
        expect(screen.getByTestId('feed-preparing-idle-scene')).toBeTruthy();
    });
});

describe('the scene has exactly one implementation', () => {
    it('is not inlined by either consumer', () => {
        // The regression this file exists for. Both cards must DELEGATE; neither
        // may mount its own LottieView.
        const fs = require('fs');
        const path = require('path');
        const root = path.resolve(__dirname, '..');
        for (const file of ['AllCaughtUpCard.tsx', 'processing/FeedProcessingCard.tsx']) {
            const src = fs.readFileSync(path.join(root, file), 'utf8');
            const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
            expect(code).not.toMatch(/LottieView/);
            expect(code).toMatch(/IdleScene/);
        }
    });
});
