// DEPRECATED(app-rethink wave): replaced by components/custom/triage/* (triage
// renders one card at a time, no per-row deck slot). Kept live only because the
// still-mounted Browse deck uses it. Do NOT extend.
//
// SwipeDeckRow — one row slot in the Browse swipe deck's FlatList (perf item
// A9). Subscribes to its OWN suggestion via a per-item zustand selector
// instead of the parent reading `suggestionsById.get(id)` on every render.
//
// `suggestionsById` is replaced wholesale (a new Map) whenever a fresh chunk
// is folded in (see swipe-feed-store's handleRelease), but existing entries
// keep their original object reference — only newly-added ids get new
// objects. So this row's selector re-runs on every store update, but zustand's
// default Object.is equality only triggers a re-render for the row(s) whose
// own suggestion reference actually changed. That's the point: scoping
// re-renders to the affected row(s) instead of the whole list.

import SwipeCard from '@/components/custom/swipe-feed/SwipeCard';
import { useSwipeFeedStore } from '@/lib/stores/swipe-feed-store';
import React, { useCallback } from 'react';
import { View } from 'react-native';

interface SwipeDeckRowProps {
  id: string;
  height: number;
  /** Stable callback from the screen; invoked with this row's id so the
   *  screen can look up the suggestion once (for the open-detail side
   *  effects) without every row closing over a fresh inline arrow. */
  onOpenDetail: (id: string) => void;
}

const SwipeDeckRow: React.FC<SwipeDeckRowProps> = ({ id, height, onOpenDetail }) => {
  const suggestion = useSwipeFeedStore((s) => s.suggestionsById.get(id));

  const handleOpenDetail = useCallback(() => {
    onOpenDetail(id);
  }, [id, onOpenDetail]);

  return (
    <View style={{ height, justifyContent: 'center' }}>
      {suggestion ? (
        <SwipeCard suggestion={suggestion} onOpenDetail={handleOpenDetail} />
      ) : null}
    </View>
  );
};

export default React.memo(SwipeDeckRow);
