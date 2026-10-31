// The four-tab shell (app_container/_layout.tsx): trigger order IS the tab order and the
// initial tab (expo-router lists declared screens first, in order), and each tab item carries
// its own accessibility label, which is the only thing VoiceOver and TalkBack read.
import { act, render } from '@testing-library/react-native';
import type React from 'react';

type TriggerProps = Record<string, unknown> & { name: string };
const mockTriggers: TriggerProps[] = [];

jest.mock('expo-router/native-tabs', () => {
  const Trigger = (props: TriggerProps & { children?: React.ReactNode }) => {
    const { children: _children, ...rest } = props;
    mockTriggers.push(rest as TriggerProps);
    return null;
  };
  Trigger.Badge = () => null;
  Trigger.Icon = () => null;
  Trigger.Label = () => null;
  Trigger.VectorIcon = () => null;
  const NativeTabs = ({ children }: { children: React.ReactNode }) => children;
  NativeTabs.Trigger = Trigger;
  return { NativeTabs };
});
jest.mock('@expo/vector-icons', () => ({ MaterialIcons: () => null }));
jest.mock('@/components/custom/ModelDownloadBanner', () => () => null);
jest.mock('@/components/custom/cards/use-starred-publications-sync', () => ({ useStarredPublicationsSync: () => {} }));
jest.mock('@/lib/database/services/notification-service', () => ({ observeUnreadCount: () => require('rxjs').of(0) }));
jest.mock('@/lib/stores/fact-checks-store', () => ({ useChecksUnseen: () => false }));

import * as TabLayout from '@/app/logged-in/app_container/_layout';
import { setTabDot } from '@/components/custom/nav/current-surface';
import { initI18nEn } from '@/test/helpers';

const AppLayout = TabLayout.default;

function lastRender(): TriggerProps[] {
  return mockTriggers.slice(-4);
}

beforeAll(async () => {
  await initI18nEn();
});

beforeEach(() => {
  mockTriggers.length = 0;
  for (const tab of ['feed', 'world', 'library', 'you'] as const) setTabDot(tab, false);
});

it('declares Feed, World, Library, You in that order, Feed first, with no anchor override', async () => {
  await render(<AppLayout />);
  expect(lastRender().map((t) => t.name)).toEqual(['feed', 'world', 'library', 'you']);
  expect((TabLayout as Record<string, unknown>).unstable_settings).toBeUndefined();
});

it('gives every tab item its name as the label, and says when it has a dot', async () => {
  await render(<AppLayout />);
  expect(lastRender().map((t) => t.accessibilityLabel)).toEqual(['Feed', 'World', 'Library', 'You']);

  await act(() => setTabDot('world', true));
  expect(lastRender().map((t) => t.accessibilityLabel)).toEqual([
    'Feed',
    'World, new updates',
    'Library',
    'You',
  ]);
});

it('leaves the re-tap to JS and keeps the native pop to root', async () => {
  await render(<AppLayout />);
  for (const t of lastRender()) {
    expect(t.disableScrollToTop).toBe(true);
    expect(t.disablePopToTop).toBeUndefined();
    expect(t.unstable_nativeProps).toBeUndefined();
  }
});
