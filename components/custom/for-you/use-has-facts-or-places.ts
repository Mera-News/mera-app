// Whether the reader has any fact or any place: the same predicate as the sync's own gate (D1), so a reader with
// a place but no facts is never shown the "no facts yet" state while a real run is in flight. Null until read.
import { useEffect, useState } from 'react';
import { combineLatest } from 'rxjs';

import { observeFacts } from '@/lib/database/services/fact-service';
import { observeAll as observeLocations } from '@/lib/database/services/location-service';

export function useHasFactsOrPlaces(): boolean | null {
  const [has, setHas] = useState<boolean | null>(null);
  useEffect(() => {
    const sub = combineLatest([observeFacts(), observeLocations()]).subscribe({
      next: ([facts, places]) => setHas(facts.length > 0 || places.length > 0),
      error: () => setHas(null),
    });
    return () => sub.unsubscribe();
  }, []);
  return has;
}
