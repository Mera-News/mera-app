// The persona snapshots (topics, facts, locations) that the Dashboard's
// section selector and the fact feed read, kept FRESH.
//
// Both screens used to load them once: the Dashboard only when
// `hasGeneratedInterests` or `suggestions.length` changed, the fact feed only
// on mount. A fact added in chat changes neither, so its new topic ids were
// unknown to the selector and its stories could not claim a section until the
// app restarted. This reloads on:
//   - any facts-table change (`observeFacts`, which emits on in-place column
//     writes too). Topic generation inserts the topics BEFORE it stamps the
//     fact's `topics_status` 'done' (topic-generation-status-service), so the
//     emission that follows the stamp reads the new topics.
//   - any locations-table change (a residence move changes headline sections).
//   - the screen gaining focus. Topic-only edits (review, retire) never touch
//     the facts table, so focus is what catches those.
//   - whatever extra `deps` the caller passes (the Dashboard keeps its
//     suggestion-count trigger).
// Emissions are debounced: a fact commit writes several rows in a burst.
//
// This is the IN-SESSION half of F20 only. On device the missing interests had
// no rows at or above the render gate at all, which no reload can fix.

import { observeFacts } from '@/lib/database/services/fact-service';
import { observeAll as observeLocations } from '@/lib/database/services/location-service';
import logger from '@/lib/logger';
import { loadSectionSnapshots, type SectionSnapshots } from '@/lib/stores/section-snapshots';
import { useIsFocused } from '@react-navigation/native';
import { useEffect, useRef, useState } from 'react';
import { skip } from 'rxjs/operators';

export const SNAPSHOT_RELOAD_DEBOUNCE_MS = 300;

export function useSectionSnapshots(
  screen: string,
  deps: readonly unknown[] = [],
): SectionSnapshots | null {
  const [snapshots, setSnapshots] = useState<SectionSnapshots | null>(null);
  const [version, setVersion] = useState(0);
  const isFocused = useIsFocused();
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Table changes bump a version, debounced.
  useEffect(() => {
    const bump = () => {
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => {
        timer.current = null;
        setVersion((v) => v + 1);
      }, SNAPSHOT_RELOAD_DEBOUNCE_MS);
    };
    const onError = (err: unknown) =>
      logger.captureException(err, { tags: { screen, method: 'observeSectionInputs' } });
    // skip(1): a WatermelonDB query emits its CURRENT rows on subscribe, which
    // is not a change. Without the skip every mount (every "Next" hop too)
    // loaded the snapshots a second time 300ms after the first.
    const facts = observeFacts().pipe(skip(1)).subscribe({ next: bump, error: onError });
    const locations = observeLocations().pipe(skip(1)).subscribe({ next: bump, error: onError });
    return () => {
      facts.unsubscribe();
      locations.unsubscribe();
      if (timer.current) clearTimeout(timer.current);
    };
  }, [screen]);

  useEffect(() => {
    if (!isFocused) return;
    let cancelled = false;
    loadSectionSnapshots()
      .then((s) => {
        if (!cancelled) setSnapshots(s);
      })
      .catch((err: unknown) => {
        logger.captureException(err, { tags: { screen, method: 'loadSectionSnapshots' } });
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isFocused, version, screen, ...deps]);

  return snapshots;
}
