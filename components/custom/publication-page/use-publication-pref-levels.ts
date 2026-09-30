// The more/fewer state of any publication, read locally from the observed
// `publication_preferences` rows with no network wait. The Sources rows use it
// for their state glyph. A row passes EVERY name it knows the publication by
// (`publisherPrefNames`); a mixed state shows the stronger one, and fewer wins
// over more, by the data area's `resolvePrefLevel`.

import { observeActive as observeActivePublicationPreferences } from '@/lib/database/services/publication-preference-service';
import { resolvePrefLevel, type PrefRowLike, type SourcePrefUiLevel } from '@/lib/database/services/publication-pref-level';
import { useCallback, useEffect, useState } from 'react';

export function usePublicationPrefLevels(): (names: readonly string[]) => SourcePrefUiLevel {
    const [rows, setRows] = useState<readonly PrefRowLike[]>([]);
    useEffect(() => {
        const sub = observeActivePublicationPreferences().subscribe((next) => setRows(next));
        return () => sub.unsubscribe();
    }, []);
    return useCallback((names: readonly string[]) => resolvePrefLevel(rows, names), [rows]);
}
