// A followed story the reader has never gone to see. A dot needs something new, and a story
// followed in onboarding has no updates yet, so without this nothing leads a reader who lands
// on World to Stories. Lights the Feed tab and the Stories pill until Stories is opened.

import { useEffect, useState } from 'react';
import { create } from 'zustand';

const OPENED_SETTING = 'stories_page_opened';

const useOpenedStore = create<{ opened: boolean | null }>(() => ({ opened: null }));

/** Lazy, so the tab shell's graph never loads the SQLite singleton at import. */
function settings(): typeof import('@/lib/database/services/setting-service') {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return require('@/lib/database/services/setting-service');
}

export function useStoriesUnopened(): boolean {
    const opened = useOpenedStore((s) => s.opened);
    const [following, setFollowing] = useState(false);
    useEffect(() => {
        void settings()
            .getSetting(OPENED_SETTING)
            .then((v) => useOpenedStore.setState({ opened: v === '1' }))
            .catch(() => undefined);
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const { observeActive } = require('@/lib/database/services/tracked-story-service') as typeof import('@/lib/database/services/tracked-story-service');
        const sub = observeActive().subscribe({
            next: (rows) => setFollowing(rows.length > 0),
            error: () => setFollowing(false),
        });
        return () => sub.unsubscribe();
    }, []);
    return following && opened === false;
}

export async function markStoriesOpened(): Promise<void> {
    if (useOpenedStore.getState().opened === true) return;
    useOpenedStore.setState({ opened: true });
    await settings().setSetting(OPENED_SETTING, '1');
}

export function __resetStoriesOpenedForTests(): void {
    useOpenedStore.setState({ opened: null });
}
