// The more/fewer state of every named publication, read locally from the
// `publication_preferences` rows with no network wait. The Sources rows use it
// for their state glyph. A row asks `levelFor(...names)` with every name it
// knows the publication by; a mixed state shows the stronger one, and fewer
// wins over more.

import { observeActive as observeActivePublicationPreferences } from '@/lib/database/services/publication-preference-service';
import type { SourcePrefUiLevel } from '@/lib/database/services/publication-pref-ui-actions';
import { useCallback, useEffect, useState } from 'react';

const normName = (s: string): string => s.toLowerCase().trim().replace(/\s+/g, ' ');

export function usePublicationPrefLevels(): (...names: (string | null | undefined)[]) => SourcePrefUiLevel {
    const [levels, setLevels] = useState<ReadonlyMap<string, SourcePrefUiLevel>>(new Map());
    useEffect(() => {
        const sub = observeActivePublicationPreferences().subscribe((rows) => {
            const next = new Map<string, SourcePrefUiLevel>();
            for (const p of rows) {
                // A scope row's label is never a publication name.
                if (p.scopeKind != null) continue;
                const name = normName(p.publicationName ?? '');
                if (!name) continue;
                // Mute (weight <= -0.9) shows as fewer: the row has three
                // states, and mute stays exclusive to the Source-preferences
                // screen.
                next.set(name, p.weight > 0 ? 'prioritised' : p.weight < 0 ? 'deprioritised' : 'none');
            }
            setLevels(next);
        });
        return () => sub.unsubscribe();
    }, []);
    return useCallback(
        (...names) => {
            let more = false;
            for (const raw of names) {
                const level = raw ? levels.get(normName(raw)) : undefined;
                if (level === 'deprioritised') return 'deprioritised';
                if (level === 'prioritised') more = true;
            }
            return more ? 'prioritised' : 'none';
        },
        [levels],
    );
}
