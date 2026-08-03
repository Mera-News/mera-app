/* eslint-disable @typescript-eslint/no-require-imports */
import { fireEvent, render } from '@testing-library/react-native';
import React from 'react';

// The animated gradient backdrop is pure decoration and asserts nothing here,
// but it imports react-native-reanimated, whose worklets runtime cannot
// initialise under Jest. Stubbing the component keeps reanimated out of this
// suite's module graph entirely — cheaper and less fragile than mocking the
// whole animation library for a view that renders no testable content.
jest.mock('@/components/custom/AbstractGradientBackdrop', () => ({
    __esModule: true,
    default: () => null,
}));

jest.mock('react-native-css-interop/jsx-runtime', () => {
    const R = require('react/jsx-runtime');
    return { jsx: R.jsx, jsxs: R.jsxs, Fragment: R.Fragment };
});
jest.mock('react-native-css-interop/jsx-dev-runtime', () => {
    const R = require('react/jsx-dev-runtime');
    return { jsxDEV: R.jsxDEV, Fragment: R.Fragment };
});

jest.mock('react-i18next', () => ({
    useTranslation: () => ({ t: (k: string, o?: any) => (o?.count != null ? `${k}:${o.count}` : k) }),
}));

jest.mock('expo-router', () => ({ router: { push: jest.fn() } }));
jest.mock('@/lib/haptics', () => ({ hapticLight: jest.fn() }));
jest.mock('react-native-safe-area-context', () => ({
    useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

// jest-expo mis-transforms RN's ScrollView native component ("Unexpected token
// 'export'") and FlatList's VirtualizedList tree is brittle under the test
// renderer. Proxy RN so ScrollView → View and FlatList → a trivial map that
// renders each row (or the empty component). Every other export stays real.
jest.mock('react-native', () => {
    const actual = jest.requireActual('react-native');
    const ReactLib = require('react');
    return new Proxy(actual, {
        get(target, prop) {
            if (prop === 'ScrollView') {
                return ({ children, ...rest }: any) => ReactLib.createElement(actual.View, rest, children);
            }
            if (prop === 'FlatList') {
                return ({
                    data,
                    renderItem,
                    keyExtractor,
                    ListEmptyComponent,
                    ListHeaderComponent,
                }: any) => {
                    const resolve = (C: any) =>
                        ReactLib.isValidElement(C) ? C : typeof C === 'function' ? ReactLib.createElement(C) : null;
                    // Real RN renders the header EVEN WHEN `data` is empty, next
                    // to the empty component. The AI-disclosure note relies on
                    // its own `anyLlmHeadline` gate rather than on emptiness, so
                    // the mock must reproduce that or the gate goes untested.
                    const header = resolve(ListHeaderComponent);
                    if (!data || data.length === 0) {
                        return ReactLib.createElement(actual.View, null, header, resolve(ListEmptyComponent));
                    }
                    return ReactLib.createElement(
                        actual.View,
                        null,
                        header,
                        data.map((item: any, index: number) =>
                            ReactLib.createElement(
                                actual.View,
                                { key: keyExtractor ? keyExtractor(item, index) : index },
                                renderItem({ item, index }),
                            ),
                        ),
                    );
                };
            }
            return (target as any)[prop];
        },
    });
});

let mockRows: any[] = [];
const mockUntrack = jest.fn();
jest.mock('@/lib/database/services/tracked-story-service', () => ({
    MAX_MEMBER_IDS: 30,
    observeActive: () => ({
        subscribe: (observer: any) => {
            observer.next(mockRows);
            return { unsubscribe: jest.fn() };
        },
    }),
}));

// Deleting now goes through track-actions (it retires the linked TOPIC as well
// as dropping the row). Mocked here because the real module reaches
// topic-service → the native SQLite adapter.
jest.mock('@/lib/tracking/track-actions', () => ({
    deleteTrackedStoryById: (...a: any[]) => mockUntrack(...a),
}));

jest.mock('@/components/ui/box', () => { const { View } = require('react-native'); return { Box: (p: any) => <View {...p} /> }; });
jest.mock('@/components/ui/hstack', () => { const { View } = require('react-native'); return { HStack: (p: any) => <View {...p} /> }; });
jest.mock('@/components/ui/vstack', () => { const { View } = require('react-native'); return { VStack: (p: any) => <View {...p} /> }; });
jest.mock('@/components/ui/pressable', () => { const { Pressable } = require('react-native'); return { Pressable }; });
jest.mock('@/components/ui/text', () => { const { Text } = require('react-native'); return { Text }; });
jest.mock('@/components/ui/heading', () => { const { Text } = require('react-native'); return { Heading: (p: any) => <Text {...p} /> }; });
jest.mock('@/components/ui/button', () => {
    const { Pressable, Text } = require('react-native');
    return { Button: (p: any) => <Pressable {...p} />, ButtonText: (p: any) => <Text {...p} /> };
});
jest.mock('@/components/ui/modal', () => {
    const { View } = require('react-native');
    return {
        Modal: ({ isOpen, children }: any) => (isOpen ? <View>{children}</View> : null),
        ModalBackdrop: (p: any) => <View {...p} />,
        ModalBody: (p: any) => <View {...p} />,
        ModalContent: (p: any) => <View {...p} />,
        ModalFooter: (p: any) => <View {...p} />,
        ModalHeader: (p: any) => <View {...p} />,
    };
});
jest.mock('@expo/vector-icons', () => { const { View } = require('react-native'); return { MaterialIcons: (p: any) => <View {...p} /> }; });
jest.mock('@/components/custom/TranslatableDynamic', () => {
    const { Text } = require('react-native');
    return { __esModule: true, default: ({ text }: any) => <Text>{text}</Text> };
});

import { router } from 'expo-router';
import TrackedStoriesScreen from '../TrackedStoriesScreen';

const story = (o: Record<string, any>) => ({
    id: o.id ?? 's1',
    llmHeadline: o.llmHeadline ?? null,
    fallbackTitle: o.fallbackTitle ?? 'Fallback',
    latestTitle: o.latestTitle ?? null,
    unseenCount: o.unseenCount ?? 0,
    status: o.status ?? 'active',
    lastUpdateAt: o.lastUpdateAt ?? null,
    createdAt: o.createdAt ?? new Date(),
    memberArticleIds: o.memberArticleIds ?? ['a1', 'a2', 'a3'],
    ...o,
});

describe('TrackedStoriesScreen', () => {
    beforeEach(() => {
        mockRows = [];
        jest.clearAllMocks();
    });

    it('shows the empty state when no stories are followed', () => {
        const { getByText } = render(<TrackedStoriesScreen embedded />);
        expect(getByText('trackedStories.emptyTitle')).toBeTruthy();
        expect(getByText('trackedStories.emptyBody')).toBeTruthy();
    });

    it('gives the empty state an actionable hint + a CTA to the Feed tab', () => {
        const { getByText } = render(<TrackedStoriesScreen embedded />);
        // The hint tells the user WHERE following happens (QA: the action was
        // three levels deep with nothing on this screen pointing there).
        expect(getByText('trackedStories.emptyHint')).toBeTruthy();
        // The CTA routes to the Feed tab, where the follow action lives.
        fireEvent.press(getByText('trackedStories.emptyCta'));
        expect(router.push).toHaveBeenCalledWith('/logged-in/app_container/feed');
    });

    it('gives the row a composite a11y label: title, unseen count, total, age', () => {
        mockRows = [story({ id: 's9', llmHeadline: 'Flood update', unseenCount: 2 })];
        const { getByLabelText } = render(<TrackedStoriesScreen embedded />);
        const label = getByLabelText(/^Flood update,/).props.accessibilityLabel;
        expect(label).toContain('Flood update');
        expect(label).toContain('trackedStories.updatesBadge'); // unseen count
        expect(label).toContain('trackedStories.articleCount'); // total
    });

    it('renders a row with headline, unseen badge and ended pill', () => {
        mockRows = [
            story({ id: 's1', llmHeadline: 'Flood update', unseenCount: 2 }),
            story({ id: 's2', fallbackTitle: 'Old story', status: 'ended', unseenCount: 0 }),
        ];
        const { getByText } = render(<TrackedStoriesScreen embedded />);
        expect(getByText('Flood update')).toBeTruthy();
        // updatesBadge interpolates the count → "…updatesBadge:2".
        expect(getByText('trackedStories.updatesBadge:2')).toBeTruthy();
        expect(getByText('Old story')).toBeTruthy();
        expect(getByText('trackedStories.endedLabel')).toBeTruthy();
    });

    it('opens the timeline when a row is tapped', () => {
        mockRows = [story({ id: 's3', llmHeadline: 'Open me', unseenCount: 1 })];
        const { getByText } = render(<TrackedStoriesScreen embedded />);
        fireEvent.press(getByText('Open me'));
        expect(router.push).toHaveBeenCalledWith(
            expect.objectContaining({
                pathname: '/logged-in/story-timeline',
                params: { trackedStoryId: 's3' },
            }),
        );
    });

    // Item 27: the trash icon and the confirm button used to share the exact
    // string "Untrack story", so VoiceOver announced two buttons with the same
    // name and the user could not tell the trigger from the confirmation.
    it('gives the trash icon and the confirm button DIFFERENT labels', () => {
        mockRows = [story({ id: 's5', llmHeadline: 'Two labels' })];
        const { getByTestId, getByLabelText } = render(<TrackedStoriesScreen embedded />);
        fireEvent(getByLabelText(/^Two labels,/), 'longPress');
        const confirm = getByTestId('untrack-confirm');
        expect(confirm.props.accessibilityLabel).toBe('trackedStories.untrackConfirmCta');
        // …and it is NOT the icon's label.
        expect(confirm.props.accessibilityLabel).not.toBe('trackedStories.untrackAction');
        expect(getByLabelText('trackedStories.untrackAction')).toBeTruthy();
    });

    // EU AI Act Art. 50 (Group C1). The per-row caption was replaced by ONE
    // list-level note because repeating it under every row read as noise. The
    // disclosure itself is not optional, so these pin down exactly when it shows
    // and that a screen-reader user still gets it per-row.
    describe('AI disclosure', () => {
        it('shows one list-level note when a row has an LLM headline', () => {
            mockRows = [
                story({ id: 'a1', llmHeadline: 'Generated one' }),
                story({ id: 'a2', llmHeadline: 'Generated two' }),
            ];
            const { getAllByText } = render(<TrackedStoriesScreen embedded />);
            // ONE note for the whole list, not one per row.
            expect(getAllByText('aiDisclosure.listNote')).toHaveLength(1);
        });

        it('hides the note when NO row has an LLM headline', () => {
            // Every row is still on its `fallbackTitle` — nothing on screen is
            // AI-written, so a blanket disclosure would itself be inaccurate.
            mockRows = [
                story({ id: 'b1', llmHeadline: null, fallbackTitle: 'Plain one' }),
                story({ id: 'b2', llmHeadline: null, fallbackTitle: 'Plain two' }),
            ];
            const { queryByText } = render(<TrackedStoriesScreen embedded />);
            expect(queryByText('aiDisclosure.listNote')).toBeNull();
        });

        it('still shows the note on a MIXED list (copy is hedged for exactly this)', () => {
            mockRows = [
                story({ id: 'c1', llmHeadline: 'Generated' }),
                story({ id: 'c2', llmHeadline: null, fallbackTitle: 'Not generated yet' }),
            ];
            const { getAllByText } = render(<TrackedStoriesScreen embedded />);
            expect(getAllByText('aiDisclosure.listNote')).toHaveLength(1);
        });

        it('hides the note on an EMPTY list, where RN would otherwise still render the header', () => {
            mockRows = [];
            const { queryByText, getByText } = render(<TrackedStoriesScreen embedded />);
            expect(getByText('trackedStories.emptyTitle')).toBeTruthy();
            expect(queryByText('aiDisclosure.listNote')).toBeNull();
        });

        it('announces the disclosure per-row for a screen reader, invisibly', () => {
            // A screen-reader user landing mid-list never passes the header note,
            // so the row label carries it too. It is NOT rendered as text — the
            // whole point of the change was to remove the visible repetition.
            mockRows = [story({ id: 'd1', llmHeadline: 'Generated headline' })];
            const { getByLabelText, queryByText } = render(<TrackedStoriesScreen embedded />);
            const label = getByLabelText(/^Generated headline,/).props.accessibilityLabel;
            expect(label).toContain('aiDisclosure.short');
            // …and the headline still comes first, with the disclosure right after it.
            expect(label.indexOf('Generated headline')).toBeLessThan(label.indexOf('aiDisclosure.short'));
            expect(queryByText('aiDisclosure.short')).toBeNull();
        });

        it('does NOT announce it for a row still showing its fallback title', () => {
            mockRows = [story({ id: 'e1', llmHeadline: null, fallbackTitle: 'Human title' })];
            const { getByLabelText } = render(<TrackedStoriesScreen embedded />);
            expect(getByLabelText(/^Human title,/).props.accessibilityLabel).not.toContain(
                'aiDisclosure.short',
            );
        });
    });

    it('untracks after confirming the modal', () => {
        mockRows = [story({ id: 's4', llmHeadline: 'Drop me', unseenCount: 1 })];
        const { getByTestId, getByLabelText } = render(<TrackedStoriesScreen embedded />);
        // The row's a11y label is now COMPOSITE — headline + unseen badge +
        // total + age — so a screen-reader user hears the whole card, not just
        // its title. Match on a prefix regex rather than the bare headline.
        fireEvent(getByLabelText(/^Drop me,/), 'longPress');
        // Confirm CTA. It no longer shares copy with the trash icon that opens
        // this dialog (they both read "Untrack story", so a screen reader
        // announced two identically-named buttons); the confirm button now has
        // its own string AND a stable testID.
        fireEvent.press(getByTestId('untrack-confirm'));
        expect(mockUntrack).toHaveBeenCalledWith('s4');
    });
});
