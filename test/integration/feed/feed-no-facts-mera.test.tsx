// The no-facts card says to tap the Mera button, so readers tap the mark beside that line.
// The example profile under it and the empty Stories page open the chat too.
import { fireEvent, render, screen } from '@testing-library/react-native';
import React from 'react';
import { FeedNoFacts } from '@/components/custom/for-you/ForYouEmptyState';
import TrackedStoriesScreen from '@/components/custom/tracked-stories/TrackedStoriesScreen';
import { useFloatingChatStore } from '@/lib/stores/floating-chat-store';
import { initI18nEn } from '@/test/helpers';

jest.mock('@/components/custom/feed/FeedShortcuts', () => ({ __esModule: true, default: () => null }));
jest.mock('@/components/custom/MeraLogo', () => ({ __esModule: true, default: () => null }));
// The sample animates (reanimated) and translates; the hosts' taps are what is under test.
jest.mock('@/components/custom/floating-chat/ChatSample', () => {
    const { View } = require('react-native');
    return { __esModule: true, default: ({ kind }: { kind: string }) => <View testID={`chat-sample-${kind}`} /> };
});
jest.mock('@/components/custom/for-you/LoopScene', () => ({ __esModule: true, default: () => null }));
// The preset's Modal mock loads a native spec jest cannot parse (the Stories page mounts a sheet).
jest.mock('react-native/Libraries/Modal/Modal', () => {
    const { View } = require('react-native');
    return { __esModule: true, default: ({ visible, children }: { visible?: boolean; children?: React.ReactNode }) => (visible ? <View>{children}</View> : null) };
});

beforeAll(initI18nEn);
beforeEach(() => useFloatingChatStore.getState().collapse());

it('opens the Mera chat', async () => {
    await render(<FeedNoFacts view="continuous" />);
    expect(useFloatingChatStore.getState().isExpanded).toBe(false);

    await fireEvent.press(screen.getByTestId('feed-no-facts-mera'));

    expect(useFloatingChatStore.getState().isExpanded).toBe(true);
    expect(useFloatingChatStore.getState().context?.kind).toBe('persona');
});

it('the example profile under the card opens the same chat', async () => {
    await render(<FeedNoFacts view="continuous" />);
    expect(screen.getByTestId('chat-sample-profile')).toBeTruthy();

    await fireEvent.press(screen.getByTestId('feed-no-facts-sample'));

    expect(useFloatingChatStore.getState().isExpanded).toBe(true);
    expect(useFloatingChatStore.getState().context?.kind).toBe('persona');
});

it('an empty Stories page shows example stories, and a tap anywhere on it opens the follow chat', async () => {
    await render(<TrackedStoriesScreen />);
    expect(await screen.findByTestId('chat-sample-stories')).toBeTruthy();

    await fireEvent.press(screen.getByTestId('tracked-stories-empty-open'));

    expect(useFloatingChatStore.getState().isExpanded).toBe(true);
    expect(useFloatingChatStore.getState().context).toMatchObject({ kind: 'follow-story', page: 'stories' });
});
