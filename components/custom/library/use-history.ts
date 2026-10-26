// History's rows: the publications opened at the source in the last 30 days,
// merged across every name a publication is known by (`mergeVisitedByName`),
// most visited first. With a country (from Where you read) only that country's
// visits count, filtered BEFORE the merge so an outlet filed under two
// countries shows its visits in each. Re-read whenever the screen is focused.

import { getTopVisitedPublications, type VisitedPublication } from '@/lib/database/services/publication-visit-service';
import { useIsFocusedSafe } from '@/lib/hooks/use-is-focused-safe';
import logger from '@/lib/logger';
import { mergeVisitedByName } from '@/lib/stats/visited-publications';
import { useCallback, useEffect, useState } from 'react';

export function useHistory(country: string | null): {
    readonly items: VisitedPublication[];
    readonly loading: boolean;
    readonly reload: () => Promise<void>;
} {
    const focused = useIsFocusedSafe();
    const [items, setItems] = useState<VisitedPublication[]>([]);
    const [loading, setLoading] = useState(true);
    const reload = useCallback(async () => {
        try {
            const rows = await getTopVisitedPublications();
            setItems(mergeVisitedByName(country ? rows.filter((r) => r.countryCode === country) : rows));
        } catch (error) {
            logger.captureException(error, { tags: { screen: 'HistoryScreen', method: 'load' } });
        } finally {
            setLoading(false);
        }
    }, [country]);
    useEffect(() => {
        if (focused) void reload();
    }, [focused, reload]);
    return { items, loading, reload };
}
