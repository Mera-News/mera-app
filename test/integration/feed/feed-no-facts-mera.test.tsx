// The no-facts card says to tap the Mera button, so readers tap the mark beside that line.
import { fireEvent, render, screen } from '@testing-library/react-native';
import React from 'react';
import { FeedNoFacts } from '@/components/custom/for-you/ForYouEmptyState';
import { useFloatingChatStore } from '@/lib/stores/floating-chat-store';
import { initI18nEn } from '@/test/helpers';

jest.mock('@/components/custom/feed/FeedShortcuts', () => ({ __esModule: true, default: () => null }));
jest.mock('@/components/custom/MeraLogo', () => ({ __esModule: true, default: () => null }));

beforeAll(initI18nEn);

it('opens the Mera chat', async () => {
    await render(<FeedNoFacts view="continuous" />);
    expect(useFloatingChatStore.getState().isExpanded).toBe(false);

    await fireEvent.press(screen.getByTestId('feed-no-facts-mera'));

    expect(useFloatingChatStore.getState().isExpanded).toBe(true);
    expect(useFloatingChatStore.getState().context?.kind).toBe('persona');
});
