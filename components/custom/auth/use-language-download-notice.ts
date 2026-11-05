// When the language download notice shows (LanguageDownloadNotice.tsx), for
// first launch and Settings > Language alike.
//
// Owner rule: ONLY while the download runs. JS gets no sheet event, so it
// rides the probe call (`useCurrentProbe`): after NOTICE_DELAY_MS, gone the
// moment the call settles. There is no early give-up: iOS draws Apple's sheet
// inside the app and reports nothing while it is up, so an 8s "no sheet" guess
// abandoned readers mid-download and left the native call holding the
// translator, which then refused the next tap's sheet. The call ends the wait
// (download done, sheet closed, or its own 90s / 20s timeout).

import { useEffect, useState } from 'react';

import { useCurrentProbe } from '@/lib/hooks/use-language-switch';

export const NOTICE_DELAY_MS = 300;

/* A probe for a pack that is already there settles in well under
   NOTICE_DELAY_MS, with no sheet. Waiting it out keeps the notice from
   flashing in that case. */

/** The language to show the notice for (null: no notice). */
export function useLanguageDownloadNotice() {
    const probe = useCurrentProbe();
    const live = probe ? probe.code : null;

    const [noticeCode, setNoticeCode] = useState<string | null>(null);
    useEffect(() => {
        if (!live) {
            setNoticeCode(null);
            return;
        }
        const id = setTimeout(() => setNoticeCode(live), NOTICE_DELAY_MS);
        return () => clearTimeout(id);
    }, [live, probe]);

    return { noticeCode };
}
