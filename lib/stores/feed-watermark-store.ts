// feed-watermark-store — the "presented up to here" high-water mark for the
// two-zone For-You feed. A single monotonic epoch-ms value: every feed entry
// (`article_suggestions.created_at`, surfaced as `ForYouSuggestion.createdAt`)
// at or below it has already been PRESENTED to the user, so it belongs in the
// "Earlier" zone; anything strictly above it is genuinely new and sits in the
// top zone. The value only ever moves forward (max), and is written through to
// the settings KV so it survives reloads.

import { create } from 'zustand';
import { getSetting, setSetting } from '@/lib/database/services/setting-service';
import logger from '@/lib/logger';

/** Settings KV key the watermark is persisted under. */
export const FEED_WATERMARK_SETTING_KEY = 'feed_presented_watermark_ms';

interface FeedWatermarkState {
  /** Epoch ms of the newest already-presented feed entry. `null` = not yet
   *  hydrated from the KV — consumers must treat null as "unknown" (the feed
   *  should wait for hydrate() before splitting zones). After hydrate it is a
   *  finite number (missing KV → 0, i.e. nothing presented yet). */
  watermarkMs: number | null;
  /** One-shot read of the persisted value at boot. Missing → 0. Idempotent and
   *  never downgrades an in-memory value already advanced this session. */
  hydrate: () => Promise<void>;
  /** Move the watermark forward to `candidateMs` iff it is strictly newer than
   *  the current value (monotonic max). Fire-and-forget write-through to the KV
   *  on a real advance; a no-op (no write) otherwise. */
  advance: (candidateMs: number) => void;
}

export const useFeedWatermarkStore = create<FeedWatermarkState>((set, get) => ({
  watermarkMs: null,

  hydrate: async () => {
    try {
      const raw = await getSetting(FEED_WATERMARK_SETTING_KEY);
      const parsed = raw != null ? Number.parseInt(raw, 10) : NaN;
      const stored = Number.isFinite(parsed) ? parsed : 0;
      const current = get().watermarkMs;
      // If the session already advanced past what's on disk (advance() ran
      // before hydrate resolved), keep the newer value — hydrate never rolls back.
      set({ watermarkMs: current == null ? stored : Math.max(current, stored) });
    } catch (err) {
      logger.captureException(err, { tags: { store: 'feed-watermark-store' } });
      // Fail open: an unhydrated feed can't split zones, so default to 0
      // (nothing presented) rather than leaving it stuck at null.
      if (get().watermarkMs == null) set({ watermarkMs: 0 });
    }
  },

  advance: (candidateMs) => {
    if (!Number.isFinite(candidateMs)) return;
    const current = get().watermarkMs ?? 0;
    if (candidateMs <= current) return;
    set({ watermarkMs: candidateMs });
    setSetting(FEED_WATERMARK_SETTING_KEY, String(candidateMs)).catch((err) =>
      logger.captureException(err, { tags: { store: 'feed-watermark-store' } }),
    );
  },
}));
