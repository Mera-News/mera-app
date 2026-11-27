// The Sectioned view, fact feed and fact page build their read snapshot from the persisted card
// state (D21): an unread High at 3 days stays in the window, a viewed one does not.
import { act, renderHook } from '@testing-library/react-native';
import { resetFeedViewPrefs, setFeedAlgo } from '@/components/custom/feed/feed-view-prefs';
import { useReadSnapshot } from '@/components/custom/feed/use-read-snapshot';
import { setSetting } from '@/lib/database/services/setting-service';
import { FEED_CARD_STATE_SETTING_KEY } from '@/lib/stores/feed-order-store';
import { isWithinWindow } from '@/lib/stores/fact-rows-selector';
import type { ForYouSuggestion } from '@/lib/stores/for-you-store';

const NOW = Date.parse('2026-11-10T10:00:00.000Z');
const DAY = 86_400_000;
const high = (id: string): ForYouSuggestion =>
  ({
    _id: id,
    articleId: id,
    clusters: [],
    relevance: 0.8,
    rawScore: 0.8,
    status: 'complete',
    firstPubDate: new Date(NOW - 3 * DAY).toISOString(),
  }) as unknown as ForYouSuggestion;

beforeEach(() => resetFeedViewPrefs());

async function windowOf(rows: ForYouSuggestion[], ageDays = 3) {
  await setSetting(FEED_CARD_STATE_SETTING_KEY, JSON.stringify({ states: { viewed: ['v', 1], skipped: ['s', 1] } }));
  const { result } = await renderHook(() => useReadSnapshot(rows, []));
  await act(async () => {});
  expect(result.current).toBeDefined();
  // `high` publishes 3 days before NOW; shift the cut so the row is `ageDays` old.
  const cut = NOW - 2 * DAY - (ageDays - 3) * DAY;
  return rows.map((r) => isWithinWindow(r, cut, result.current));
}

it('keeps an unread High at 3d and drops a viewed and a scrolled-past one, from the persisted card state', async () => {
  expect(await windowOf([high('viewed'), high('skipped'), high('fresh')])).toEqual([false, false, true]);
});

it('with scrolled past not counted as read, a skipped High stays', async () => {
  setFeedAlgo({ skippedIsRead: false });
  expect(await windowOf([high('viewed'), high('skipped'), high('fresh')])).toEqual([false, true, true]);
});

it('a shorter keep drops an unread High at 3d', async () => {
  setFeedAlgo({ keepDays: 2 });
  expect(await windowOf([high('fresh')])).toEqual([false]);
});
