// Whether the reader already has a home: a residence fact (canonical location key) or a `home` location row.
// The chip hides on either, so it never adds a second, conflicting home fact (D16/D21). The World row reads
// `useHasHomeFact` for the same rule.
import { useEffect, useState } from 'react';
import { combineLatest } from 'rxjs';

import { getFacts, observeFacts } from '@/lib/database/services/fact-service';
import { getAll as getAllLocations, observeAll as observeLocations } from '@/lib/database/services/location-service';
import { CANONICAL_LOCATION_KEY } from '@/lib/mera-harness/core/combined-fact';

const isHomeFact = (f: { questionnaireAttribute?: string }) => f.questionnaireAttribute === CANONICAL_LOCATION_KEY;

export async function hasHomeFact(): Promise<boolean> {
    const [facts, locations] = await Promise.all([getFacts(), getAllLocations()]);
    return facts.some(isHomeFact) || locations.some((l) => l.role === 'home');
}

/** Null until the first read, so a caller never flashes the chip for a reader who has a home. */
export function useHasHomeFact(): boolean | null {
    const [has, setHas] = useState<boolean | null>(null);
    useEffect(() => {
        const sub = combineLatest([observeFacts(), observeLocations()]).subscribe({
            next: ([facts, locations]) => setHas(facts.some(isHomeFact) || locations.some((l) => l.role === 'home')),
            error: () => setHas(null),
        });
        return () => sub.unsubscribe();
    }, []);
    return has;
}
