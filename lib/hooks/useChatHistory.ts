// useChatHistory — lazy, paginated loader for persisted chat history.
//
// Pages messages newest-first ACROSS all conversations via
// fetchMessagesBefore, excluding the currently-open conversation. Loads
// NOTHING on mount: the first page is fetched only on the first loadOlder()
// call (triggered by the user scrolling up in the thread). Subsequent calls
// append strictly older pages. The returned array stays newest-first, exactly
// as fetched — deriveThreadItems expects history newest-first.

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  fetchMessagesBefore,
  type MessageCursor,
  type PersistedMessage,
} from '../database/services/conversation-service';
import logger from '../logger';

const PAGE_SIZE = 30;

export interface UseChatHistoryResult {
  /** Persisted messages loaded so far, newest-first. */
  history: PersistedMessage[];
  /** Loads the next (older) page. No-op while a load is in flight or exhausted. */
  loadOlder: () => void;
  /** True until the store is known to be exhausted. */
  hasOlder: boolean;
  isLoadingOlder: boolean;
}

export function useChatHistory(excludeConversationId?: string): UseChatHistoryResult {
  const [history, setHistory] = useState<PersistedMessage[]>([]);
  // Starts false and is set by a cheap size-1 probe on mount (below). The
  // history reveal is gated behind an explicit button now, so `hasOlder` must
  // reflect whether older history ACTUALLY exists rather than being
  // optimistically true — an empty-history user must not see the pill.
  const [hasOlder, setHasOlder] = useState(false);
  const [isLoadingOlder, setIsLoadingOlder] = useState(false);

  const cursorRef = useRef<MessageCursor | null>(null);
  const hasOlderRef = useRef(true);
  const inFlightRef = useRef(false);
  const seenIdsRef = useRef<Set<string>>(new Set());

  // Probe: a 1-row read tells us whether any older cross-conversation message
  // exists, so the "View previous messages" pill can appear before the first
  // real page loads. The probe does not touch the paging cursor or seen-set, so
  // the eventual first loadOlder() re-fetches its rows normally.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const { items } = await fetchMessagesBefore(null, 1, excludeConversationId);
        if (!cancelled) setHasOlder(items.length > 0);
      } catch (error) {
        logger.error('[useChatHistory] probe failed', { error: String(error) });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [excludeConversationId]);

  const loadOlder = useCallback(() => {
    if (inFlightRef.current || !hasOlderRef.current) return;
    inFlightRef.current = true;
    setIsLoadingOlder(true);

    void (async () => {
      try {
        const { items, nextCursor, hasMore } = await fetchMessagesBefore(
          cursorRef.current,
          PAGE_SIZE,
          excludeConversationId,
        );

        cursorRef.current = nextCursor;
        hasOlderRef.current = hasMore;
        setHasOlder(hasMore);

        // Dedupe by id, append older rows after the newer ones already held.
        const fresh = items.filter((m) => !seenIdsRef.current.has(m.id));
        for (const m of fresh) seenIdsRef.current.add(m.id);
        if (fresh.length > 0) {
          setHistory((prev) => [...prev, ...fresh]);
        }
      } catch (error) {
        logger.error('[useChatHistory] loadOlder failed', { error: String(error) });
      } finally {
        inFlightRef.current = false;
        setIsLoadingOlder(false);
      }
    })();
  }, [excludeConversationId]);

  return { history, loadOlder, hasOlder, isLoadingOlder };
}
