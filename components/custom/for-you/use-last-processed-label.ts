// "Last processed 4 minutes ago" for the counts card.
//
// Read by the card's bodies themselves rather than handed in by a screen, so
// every mount shows the same rows. The 30 s tick has no focus gate: the card is
// mounted only while it is open (slid in, or on an empty Feed), and one label
// re-render per tick is cheap.

import { useForYouLastProcessingRunFinishedAt } from '@/lib/stores/selectors';
import { formatTimeAgo } from '@/lib/utils/time-ago';
import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';

const TICK_MS = 30_000;

export function useLastProcessedLabel(): string | null {
    const { t } = useTranslation();
    const finishedAt = useForYouLastProcessingRunFinishedAt();
    const [now, setNow] = useState(() => Date.now());

    useEffect(() => {
        if (!finishedAt) return;
        setNow(Date.now());
        const id = setInterval(() => setNow(Date.now()), TICK_MS);
        return () => clearInterval(id);
    }, [finishedAt]);

    return useMemo(
        () => (finishedAt ? formatTimeAgo(t, finishedAt, { now }) : null),
        [finishedAt, now, t],
    );
}
