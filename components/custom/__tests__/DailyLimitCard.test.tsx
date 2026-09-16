// DailyLimitCard — the empty state for "today's cap is reached and nothing
// more will be fetched".
//
// It exists because the empty-state chain had no branch for the capped state,
// so a capped reader fell through to FeedProcessingCard and was told "Mera is
// preparing your feed" while the status indicator in the SAME header said
// "Daily article limit reached". The card was the surface that was false.
//
// The gluestack primitives are stubbed for the same reason AllCaughtUpCard's
// spec stubs them: they pull ActivityIndicator's native component in, which
// does not load in this environment.
/* eslint-disable @typescript-eslint/no-require-imports */

jest.mock('react-i18next', () => ({
    useTranslation: () => ({
        t: (key: string, vars?: Record<string, unknown>) => {
            const en = require('@/lib/locales/en.json');
            const v = key.split('.').reduce<any>((acc, part) => acc?.[part], en);
            if (typeof v !== 'string') return key;
            return vars
                ? v.replace(/\{\{(\w+)\}\}/g, (_m: string, n: string) => String(vars[n] ?? ''))
                : v;
        },
    }),
}));
jest.mock('expo-router', () => ({ router: { navigate: jest.fn() } }));

let mockResetAt: number | null = null;
jest.mock('@/lib/stores/selectors', () => ({
    useForYouDailyLimitResetAt: () => mockResetAt,
}));

jest.mock('@/components/ui/box', () => {
    const { View } = require('react-native');
    return { Box: (p: any) => <View {...p} /> };
});
jest.mock('@/components/ui/text', () => {
    const { Text } = require('react-native');
    return { Text: (p: any) => <Text {...p} /> };
});
jest.mock('@/components/ui/button', () => {
    const { Pressable, Text } = require('react-native');
    return {
        Button: (p: any) => <Pressable {...p} />,
        ButtonText: (p: any) => <Text {...p} />,
    };
});

import { render, screen } from '@testing-library/react-native';
import React from 'react';
import DailyLimitCard from '../DailyLimitCard';
import en from '@/lib/locales/en.json';

const RESET_AT = Date.UTC(2026, 8, 17, 0, 0, 0);

describe('DailyLimitCard', () => {
    beforeEach(() => {
        mockResetAt = RESET_AT;
    });

    it('says the limit is reached, and never that a feed is being prepared', () => {
        render(<DailyLimitCard />);
        expect(screen.getByTestId('daily-limit-headline')).toHaveTextContent(
            en.feed.dailyLimit.title,
        );
        // The regression this card was written for.
        expect(screen.queryByText(en.feed.preparingFeed)).toBeNull();
    });

    it('never uses the untimed "tomorrow" copy', () => {
        // The cap resets at 00:00 UTC, which is 5pm the SAME DAY in Los
        // Angeles, so `feed.dailyLimit.body` is false for a large share of
        // readers. It still exists in all 20 dictionaries and must stay unused.
        render(<DailyLimitCard />);
        expect(screen.queryByText(en.feed.dailyLimit.body)).toBeNull();
    });

    it('holds the scene at frame 0 instead of looping it', () => {
        // A loop claims something is arriving. Nothing arrives until the cap
        // resets, so looping here would restate the false claim in motion.
        render(<DailyLimitCard />);
        const scene = screen.getByTestId('daily-limit-scene');
        const lottie = scene.props.children;
        expect(lottie.props.autoPlay).toBe(false);
        expect(lottie.props.progress).toBe(0);
        expect(lottie.props.loop).toBe(false);
    });

    it('renders when no reset instant is known rather than throwing', () => {
        mockResetAt = null;
        render(<DailyLimitCard />);
        expect(screen.getByTestId('daily-limit-headline')).toBeTruthy();
    });
});
