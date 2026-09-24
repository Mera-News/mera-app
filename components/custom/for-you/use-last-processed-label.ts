// "Last processed 4 minutes ago" for the status panel body.
//
// Read by the body itself rather than handed in by a screen, so every mount of
// the status body shows the same rows. It used to be a prop only the Dashboard
// passed, which is how the Feed's panel came to lack the row.
//
// The tick needs no focus gate: the body mounts only while its panel is open,
// and an open panel closes itself after STATUS_PANEL_AUTO_COLLAPSE_MS.

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
