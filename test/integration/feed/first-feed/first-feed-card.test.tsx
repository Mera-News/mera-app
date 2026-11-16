// FirstFeedCard (D9): the one dismissible privacy card above the counts card. Real in-memory DB for the
// setting; only the explainer sheet is faked.
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import React from 'react';
import FirstFeedCard from '@/components/custom/for-you/FirstFeedCard';
import { getSetting, setSetting } from '@/lib/database/services/setting-service';
import { useForYouStore } from '@/lib/stores/for-you-store';
import { initI18nEn } from '@/test/helpers';

jest.mock('@/components/custom/MeraLogo', () => () => null);
jest.mock('@/components/custom/nav/PageExplainerSheet', () => {
  const { View } = require('react-native');
  return { __esModule: true, default: ({ open }: { open: boolean }) => (open ? <View testID="explainer-open" /> : null) };
});

const KEY = 'feed_privacy_intro_dismissed';
beforeAll(initI18nEn);
beforeEach(async () => {
  await setSetting(KEY, '');
  useForYouStore.setState({ suggestionsHydrated: true, lastProcessingRunFinishedAt: null });
});

it('shows the privacy copy with no false claim', async () => {
  await render(<FirstFeedCard />);
  expect(await screen.findByTestId('first-feed-card')).toBeTruthy();
  expect(screen.getByText(/What you tell Mera stays on this phone/)).toBeTruthy();
  expect(screen.queryByText(/nothing leaves/i)).toBeNull();
});

it('dismiss hides it and stores the dismissal', async () => {
  await render(<FirstFeedCard />);
  await fireEvent.press(await screen.findByTestId('first-feed-dismiss'));
  await waitFor(() => expect(screen.queryByTestId('first-feed-card')).toBeNull());
  expect(await getSetting(KEY)).toBe('1');
});

it('stays hidden once dismissed', async () => {
  await setSetting(KEY, '1');
  await render(<FirstFeedCard />);
  await act(async () => {});
  expect(screen.queryByTestId('first-feed-card')).toBeNull();
});

it('the link opens the Feed explainer', async () => {
  await render(<FirstFeedCard />);
  await fireEvent.press(await screen.findByTestId('first-feed-link'));
  expect(screen.getByTestId('explainer-open')).toBeTruthy();
});

it('a run finishing during the first session keeps it; a later session finds it spent', async () => {
  const first = await render(<FirstFeedCard />);
  await screen.findByTestId('first-feed-card');
  await act(async () => useForYouStore.setState({ lastProcessingRunFinishedAt: Date.now() }));
  expect(screen.getByTestId('first-feed-card')).toBeTruthy();
  first.unmount();
  // Next session: a run is already on record when the card first looks.
  await render(<FirstFeedCard />);
  await waitFor(async () => expect(await getSetting(KEY)).toBe('1'));
  expect(screen.queryByTestId('first-feed-card')).toBeNull();
});
