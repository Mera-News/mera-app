// Whether Mera knows at least one fact about the reader: the Feed's "No facts
// yet" gate (FinalFeed #8, #9) in both views. Null until the first read, and
// the block never shows while null. Facts can exist before their topics do;
// that case is the processing state, not this one.

import { observeFacts } from '@/lib/database/services/fact-service';
import { useEffect, useState } from 'react';

export function useHasFacts(): boolean | null {
  const [has, setHas] = useState<boolean | null>(null);
  useEffect(() => {
    const sub = observeFacts().subscribe({
      next: (facts) => setHas(facts.length > 0),
      error: () => setHas(null),
    });
    return () => sub.unsubscribe();
  }, []);
  return has;
}
