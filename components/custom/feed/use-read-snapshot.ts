// The Sectioned view, the fact feed and the fact page judge the 7-day keep of
// unread High rows (D7, D21) with the same read snapshot as the Feed. Card
// states are read ONCE per mount (order store when hydrated, else the
// persisted blob), so a view mark never rebuilds the lists; opened ids and the
// pool are live. `undefined` until the card states loaded: plain 48h window.

import { useEffect, useMemo, useState } from 'react';
import { getSetting } from '@/lib/database/services/setting-service';
import { readOptionsOf } from '@/lib/feed-ordering/feed-algo';
import { buildReadSnapshot, parseCardState, type ReadSnapshot } from '@/lib/feed-ordering/read-snapshot';
import { useFeedAlgo } from './feed-view-prefs';
import { FEED_CARD_STATE_SETTING_KEY, useFeedOrderStore, type CardStateRecord } from '@/lib/stores/feed-order-store';
import type { ForYouSuggestion } from '@/lib/stores/for-you-store';

export function useReadSnapshot(
  suggestions: readonly ForYouSuggestion[],
  openedIds: Iterable<string>,
): ReadSnapshot | undefined {
  const [cardStates, setCardStates] = useState<Record<string, CardStateRecord> | null>(() => {
    const s = useFeedOrderStore.getState();
    return s.hydrated ? s.cardStates : null;
  });
  useEffect(() => {
    if (cardStates) return;
    let live = true;
    getSetting(FEED_CARD_STATE_SETTING_KEY)
      .then((raw) => live && setCardStates(parseCardState(raw)))
      .catch(() => live && setCardStates({}));
    return () => {
      live = false;
    };
  }, [cardStates]);
  // The reader's keep and "scrolled past is read" (Settings > Feed algorithm).
  const algo = useFeedAlgo();
  return useMemo(
    () => (cardStates ? buildReadSnapshot(cardStates, openedIds, suggestions, readOptionsOf(algo)) : undefined),
    [cardStates, openedIds, suggestions, algo],
  );
}
