/* eslint-disable @typescript-eslint/no-require-imports */
import { act, configure, fireEvent, render, screen } from '@testing-library/react-native';
import React from 'react';

configure({ defaultIncludeHiddenElements: true });

jest.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (k: string, o?: Record<string, unknown>) => (o ? `${k}:${JSON.stringify(o)}` : k) }),
}));
let mockPages: { id: string; scope: { label: string } }[] = [];
jest.mock('@/lib/explore/world-pages', () => ({ useWorldPages: () => ({ pages: mockPages, loaded: true }) }));
let mockSaved: unknown[] = [];
jest.mock('@/lib/database/services/saved-article-suggestion-service', () => ({
  loadSavedItems: () => Promise.resolve(mockSaved),
}));
let mockActive: unknown[] = [];
jest.mock('@/lib/database/services/tracked-story-service', () => ({
  observeActive: () => ({
    subscribe: (o: { next: (rows: unknown[]) => void }) => {
      o.next(mockActive);
      return { unsubscribe: () => undefined };
    },
  }),
}));
const mockNavigateToPage = jest.fn();
jest.mock('@/components/custom/nav/navigate-to-page', () => ({
  navigateToPage: (...a: unknown[]) => mockNavigateToPage(...a),
}));
jest.mock('@/lib/navigation/focus-target', () => ({ navigateToSetting: jest.fn() }));
jest.mock('@/components/custom/notifications/NotificationBellButton', () => ({ __esModule: true, default: () => null }));
jest.mock('@/components/custom/GlassSurface', () => ({ GlassPanel: ({ children }: any) => children }));
jest.mock('@/components/ui/text', () => {
  const { Text } = require('react-native');
  return { Text: (p: any) => <Text {...p} /> };
});
jest.mock('@/components/ui/pressable', () => {
  const { Pressable } = require('react-native');
  return { Pressable };
});
jest.mock('@expo/vector-icons', () => require('@/lib/__test-helpers__/icon-glyph-a11y').glyphIconModule());

import FeedShortcuts, { captionIndex, resetCaptionPicks } from '../FeedShortcuts';

async function renderShortcuts() {
  render(<FeedShortcuts />);
  await act(async () => {});
}

beforeEach(() => {
  resetCaptionPicks();
  mockPages = [{ id: 'world', scope: { label: 'World' } }];
  mockSaved = [];
  mockActive = [];
  mockNavigateToPage.mockClear();
});

describe('FeedShortcuts', () => {
  it('always offers World; the others only when their page has something', async () => {
    await renderShortcuts();
    expect(screen.getByTestId('feed-shortcut-world')).toBeTruthy();
    expect(screen.queryByTestId('feed-shortcut-saved')).toBeNull();
    expect(screen.queryByTestId('feed-shortcut-stories')).toBeNull();
  });

  it('adds the first country, Saved and Stories when they have content', async () => {
    mockPages = [
      { id: 'world', scope: { label: 'World' } },
      { id: 'country:DE', scope: { label: 'Germany' } },
      { id: 'country:NL', scope: { label: 'Netherlands' } },
    ];
    mockSaved = [{}];
    mockActive = [{}];
    await renderShortcuts();
    expect(screen.getByTestId('feed-shortcut-country:DE')).toBeTruthy();
    expect(screen.queryByTestId('feed-shortcut-country:NL')).toBeNull();
    expect(screen.getByTestId('feed-shortcut-saved')).toBeTruthy();
    expect(screen.getByTestId('feed-shortcut-stories')).toBeTruthy();
  });

  it('reads each row once as "<page>, <caption>" and opens its page', async () => {
    mockPages = [
      { id: 'world', scope: { label: 'World' } },
      { id: 'country:DE', scope: { label: 'Germany' } },
    ];
    await renderShortcuts();
    const row = screen.getByTestId('feed-shortcut-country:DE');
    expect(row.props.accessibilityLabel).toMatch(/^Germany, feedShortcuts\.country[12]:\{"country":"Germany"\}$/);
    fireEvent.press(row);
    expect(mockNavigateToPage).toHaveBeenCalledWith('country:DE');
  });

  it('leaks no icon glyph into a label', async () => {
    mockSaved = [{}];
    await renderShortcuts();
    const { privateUseLabelLeaks } = require('@/lib/__test-helpers__/icon-glyph-a11y');
    expect(privateUseLabelLeaks(screen.root)).toEqual([]);
  });
});

describe('captionIndex', () => {
  it('picks once per process per pool, in range, and never stores anything else', () => {
    const first = captionIndex('world', 2, () => 0.9);
    expect(first).toBe(1);
    expect(captionIndex('world', 2, () => 0)).toBe(1);
    expect(captionIndex('saved', 2, () => 0)).toBe(0);
  });
});
