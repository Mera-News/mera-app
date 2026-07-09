// useChatHistory — lazy, paginated loader for persisted chat history.
//
// Pages messages newest-first ACROSS all conversations via
// fetchMessagesBefore, excluding the currently-open conversation. Loads
// NOTHING on mount: the first page is fetched only on the first loadOlder()
// call (triggered by the user scrolling up in the thread). Subsequent calls
// append strictly older pages. The returned array stays newest-first, exactly
// as fetched — deriveThreadItems expects history newest-first.

import { useCallback, useRef, useState } from 'react';
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
  // Optimistically true until the first fetch tells us otherwise — this is
  // what lets the thread offer a scroll-up load before anything is fetched.
  const [hasOlder, setHasOlder] = useState(true);
  const [isLoadingOlder, setIsLoadingOlder] = useState(false);

  const cursorRef = useRef<MessageCursor | null>(null);
  const hasOlderRef = useRef(true);
  const inFlightRef = useRef(false);
  const seenIdsRef = useRef<Set<string>>(new Set());

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
