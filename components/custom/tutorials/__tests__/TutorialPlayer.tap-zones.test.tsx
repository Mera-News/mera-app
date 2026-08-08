// Stories-style tap zones on the tutorial player.
//
// Left half = previous card, right half = next card. Four things have to hold at
// once, and three of them are the kind that only bite on a device:
//
//  1. the zones navigate,
//  2. they do NOT steal a tap meant for an interaction,
//  3. they do NOT bypass the interaction gate the Next button respects,
//  4. the first and last cards behave, rather than crashing or dead-ending.
//
// ⚠️ WHAT THIS FILE CANNOT PROVE. `fireEvent.press` invokes a node's handler
// directly — there is no hit-testing and no z-order in the test renderer, so a
// test that presses a choice and then asserts the slide did not change would
// pass even if the zones were layered ON TOP of the interactions in production.
// The layering itself lives in exactly one prop, `pointerEvents="none"` on the
// scene and copy wrappers, and the structural test at the bottom pins that prop
// because it is the only part of the mechanism this renderer can see. The real
// z-order check is a device check.
/* eslint-disable @typescript-eslint/no-require-imports */

import { act, configure, fireEvent, render } from '@testing-library/react-native';
import React from 'react';

// The zones are deliberately HIDDEN from the accessibility tree — the footer
// already offers a labelled Back and Next, and two unlabelled full-height
// buttons would only be noise to a screen reader. RNTL excludes hidden elements
// from its queries by default, so this file opts back in; the test at the bottom
// pins that they really are hidden, so nothing is being papered over.
configure({ defaultIncludeHiddenElements: true });

jest.mock('react-i18next', () => ({
    useTranslation: () => ({
        t: (key: string) => {
            const en = require('@/lib/locales/en.json');
            const v = key.split('.').reduce<any>((acc, part) => acc?.[part], en);
            return typeof v === 'string' ? v : key;
        },
    }),
}));

jest.mock('@expo/vector-icons', () => {
    const { View } = require('react-native');
    return { MaterialIcons: (p: any) => <View {...p} /> };
});

jest.mock('react-native-safe-area-context', () => ({
    useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

// A bare re-export of react-native's ScrollView, stubbed here for the reason it
// exists: the real one drags an untransformed native-component spec into the
// test runtime.
jest.mock('@/components/ui/scroll-view', () => {
    const { View } = require('react-native');
    return { ScrollView: (p: any) => <View {...p} /> };
});

jest.mock('@/lib/haptics', () => ({
    hapticLight: jest.fn(),
    hapticMedium: jest.fn(),
}));

// The scene is animated (reanimated shared values) and irrelevant here; the
// wrapper that makes it transparent to touches lives in SlideView, not in it.
jest.mock('@/components/custom/tutorials/SceneView', () => {
    const { View } = require('react-native');
    return { __esModule: true, default: () => <View testID="scene" /> };
});

// The real store reaches the settings KV, which instantiates the WatermelonDB
// singleton at import.
const mockMarkCompleted = jest.fn();
jest.mock('@/lib/stores/tutorials-store', () => ({
    useTutorialsStore: Object.assign(
        (selector: any) => selector({ markCompleted: mockMarkCompleted }),
        {
            getState: () => ({
                markCompleted: mockMarkCompleted,
                hydrate: jest.fn(),
                markMenuSeen: jest.fn(),
            }),
        },
    ),
}));

// Ask Mera is its own concern (and its own test); keep it out of the tree so
// this file does not depend on the subscription or user stores.
jest.mock('@/components/custom/tutorials/AskMeraButton', () => {
    const { View } = require('react-native');
    return { __esModule: true, default: () => <View testID="ask-mera" /> };
});

import TutorialPlayer, { UNGATE_AFTER_MS } from '../TutorialPlayer';

// `welcome` is the real registry chapter and its shape is what these tests
// stand on: card 0 (`what`) is ungated, card 1 (`not-a-timeline`) is gated by a
// `choose`, and card 5 (`begin`) is the last one.
const CHAPTER = 'welcome';

function renderPlayer(onClose = jest.fn()) {
    return { onClose, ...render(<TutorialPlayer chapterId={CHAPTER} onClose={onClose} />) };
}

beforeEach(() => {
    mockMarkCompleted.mockClear();
});

describe('tutorial tap zones', () => {
    it('advances on a tap in the right half', () => {
        const { getByTestId, queryByTestId } = renderPlayer();

        expect(queryByTestId('tutorial-slide-what')).not.toBeNull();

        fireEvent.press(getByTestId('tutorial-tap-next'));

        expect(queryByTestId('tutorial-slide-what')).toBeNull();
        expect(queryByTestId('tutorial-slide-not-a-timeline')).not.toBeNull();
    });

    it('goes back on a tap in the left half', () => {
        const { getByTestId, queryByTestId } = renderPlayer();

        fireEvent.press(getByTestId('tutorial-tap-next'));
        expect(queryByTestId('tutorial-slide-not-a-timeline')).not.toBeNull();

        fireEvent.press(getByTestId('tutorial-tap-prev'));

        expect(queryByTestId('tutorial-slide-what')).not.toBeNull();
    });

    // THE regression this feature could introduce: a tap zone that swallows the
    // taps the slide is actually asking for. Asserted from both ends — the card
    // does not move, AND the interaction registered (proved by the gate opening
    // on the next tap, which is the only observable it has).
    it('does not advance when the tap lands on an interaction', () => {
        const { getByTestId, queryByTestId } = renderPlayer();

        fireEvent.press(getByTestId('tutorial-tap-next'));
        expect(queryByTestId('tutorial-slide-not-a-timeline')).not.toBeNull();

        fireEvent.press(getByTestId('tutorial-choice-yours'));

        // Still on the same card: choosing is not navigating.
        expect(queryByTestId('tutorial-slide-not-a-timeline')).not.toBeNull();
        // And the choice was genuinely received, not eaten by a zone.
        expect(getByTestId('tutorial-choice-yours').props.accessibilityState)
            .toEqual(expect.objectContaining({ selected: true }));

        fireEvent.press(getByTestId('tutorial-tap-next'));
        expect(queryByTestId('tutorial-slide-not-a-timeline')).toBeNull();
    });

    // The zone applies the same rule as the Next button. Without this the right
    // half would walk past every interaction in the module and UNGATE_AFTER_MS
    // would be dead code.
    it('respects the interaction gate', () => {
        const { getByTestId, queryByTestId } = renderPlayer();

        fireEvent.press(getByTestId('tutorial-tap-next'));
        expect(queryByTestId('tutorial-slide-not-a-timeline')).not.toBeNull();

        fireEvent.press(getByTestId('tutorial-tap-next'));

        // Gated and unanswered — the tap bounces.
        expect(queryByTestId('tutorial-slide-not-a-timeline')).not.toBeNull();
    });

    it('un-gates the right half once the "continue anyway" timer fires', () => {
        jest.useFakeTimers();
        try {
            const { getByTestId, queryByTestId } = renderPlayer();

            fireEvent.press(getByTestId('tutorial-tap-next'));
            fireEvent.press(getByTestId('tutorial-tap-next'));
            expect(queryByTestId('tutorial-slide-not-a-timeline')).not.toBeNull();

            act(() => {
                jest.advanceTimersByTime(UNGATE_AFTER_MS + 1);
            });

            fireEvent.press(getByTestId('tutorial-tap-next'));
            expect(queryByTestId('tutorial-slide-not-a-timeline')).toBeNull();
        } finally {
            jest.useRealTimers();
        }
    });

    // Chosen behaviour, not an accident: a left tap on the first card bounces
    // rather than closing the chapter. It mirrors the disabled Back button
    // beside it, and an accidental tap must never eject a reader.
    it('bounces on a left tap on the first card', () => {
        const { getByTestId, queryByTestId, onClose } = renderPlayer();

        fireEvent.press(getByTestId('tutorial-tap-prev'));

        expect(queryByTestId('tutorial-slide-what')).not.toBeNull();
        expect(onClose).not.toHaveBeenCalled();
        expect(mockMarkCompleted).not.toHaveBeenCalled();
    });

    // And a right tap on the last card is "Done": completes and closes.
    it('finishes the chapter on a right tap on the last card', () => {
        const { getByTestId, queryByTestId, onClose } = renderPlayer();

        // `what` → `not-a-timeline` (gated, answer it) → the rest are ungated.
        fireEvent.press(getByTestId('tutorial-tap-next'));
        fireEvent.press(getByTestId('tutorial-choice-yours'));
        fireEvent.press(getByTestId('tutorial-tap-next')); // you-first
        fireEvent.press(getByTestId('tutorial-tap-next')); // matching
        fireEvent.press(getByTestId('tutorial-tap-next')); // stays-here (gated)
        fireEvent.press(getByTestId('tutorial-reveal-about-you'));
        fireEvent.press(getByTestId('tutorial-reveal-what-leaves'));
        fireEvent.press(getByTestId('tutorial-tap-next')); // begin — the last one

        expect(queryByTestId('tutorial-slide-begin')).not.toBeNull();
        expect(onClose).not.toHaveBeenCalled();

        fireEvent.press(getByTestId('tutorial-tap-next'));

        expect(mockMarkCompleted).toHaveBeenCalledWith(CHAPTER);
        expect(onClose).toHaveBeenCalled();
    });

    // The mechanism, pinned. These two wrappers are what let a tap on the
    // artwork or the headline reach the zone behind them; React Native has no
    // sibling fall-through for a view with the default `pointerEvents: 'auto'`,
    // so dropping either prop silently kills the gesture over most of the card.
    it('keeps the scene and the copy transparent to touches', () => {
        const { getByTestId } = renderPlayer();

        expect(getByTestId('tutorial-slide-scene').props.pointerEvents).toBe('none');
        expect(getByTestId('tutorial-slide-copy').props.pointerEvents).toBe('none');
    });

    it('keeps the zones out of the accessibility tree', () => {
        const { getByTestId } = renderPlayer();
        const zones = getByTestId('tutorial-tap-zones');

        expect(zones.props.accessibilityElementsHidden).toBe(true);
        expect(zones.props.importantForAccessibility).toBe('no-hide-descendants');
    });
});
