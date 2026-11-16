// The Sectioned view, fact feed and fact page build their read snapshot from the persisted card
// state (D21): an unread High at 3 days stays in the window, a viewed one does not.
import { act, renderHook } from '@testing-library/react-native';
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

it('keeps an unread High at 3d and drops a viewed one, from the persisted card state', async () => {
  await setSetting(FEED_CARD_STATE_SETTING_KEY, JSON.stringify({ states: { viewed: ['v', 1], skipped: ['s', 1] } }));
  const rows = [high('viewed'), high('skipped'), high('fresh')];
  const { result } = await renderHook(() => useReadSnapshot(rows, []));
  await act(async () => {});
  const snap = result.current;
  expect(snap).toBeDefined();
  const cut = NOW - 2 * DAY;
  expect(rows.map((r) => isWithinWindow(r, cut, snap))).toEqual([false, true, true]);
});
