import { useRestartHold } from '@/lib/app-restart';

/** Typed text is lost by a reload and is never stored, so it holds a restart. Label prefix `draft:` picks the "send or clear" toast. */
export function useSearchDraftHold(query: string): void {
  useRestartHold(query.trim().length > 0, 'draft:search', 'hard');
}
