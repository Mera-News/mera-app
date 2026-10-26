// What you opened: the windowed visits, newest first, optionally only one
// language (from Languages, fixed for the screen) and one day (picked on the
// calendar, cleared by Show all days). The calendar counts the same
// language-filtered rows, so a day's shade matches what tapping it lists.

import { useActivityVisits } from '@/components/custom/library/use-activity-visits';
import type { VisitedArticle } from '@/lib/database/services/publication-visit-service';
import { filterVisits } from '@/lib/stats/activity';
import { dailyReads, type DayRead } from '@/lib/stats/reading-stats';
import { useMemo, useState } from 'react';

export interface ReadingLog {
    readonly loading: boolean;
    /** Every visit in the language filter (the intro's count). */
    readonly all: readonly VisitedArticle[];
    /** What the list shows: `all`, narrowed to the picked day. */
    readonly rows: readonly VisitedArticle[];
    /** The 30-day calendar, oldest first, zeros included. */
    readonly days: readonly DayRead[];
    readonly day: string | null;
    readonly setDay: (day: string | null) => void;
}

export function useReadingLog({ language, initialDay }: { language: string | null; initialDay: string | null }): ReadingLog {
    const { visits, loading } = useActivityVisits();
    const [day, setDay] = useState<string | null>(initialDay);
    const all = useMemo(() => filterVisits(visits, { language }), [visits, language]);
    const days = useMemo(() => dailyReads([...all], Date.now()), [all]);
    const rows = useMemo(() => (day ? filterVisits(all, { day }) : all), [all, day]);
    return { loading, all, rows, days, day, setDay };
}
