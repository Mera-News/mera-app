// When the language download notice shows (LanguageDownloadNotice.tsx), for
// first launch and Settings > Language alike.
//
// Owner rule: ONLY while Apple's download sheet is up. JS gets no sheet event,
// so it rides the probe call (`useCurrentProbe`): iOS only, after
// NOTICE_DELAY_MS, gone the moment the call settles. If the probe never saw a
// sign of the sheet by NO_SHEET_MS, the host is let go (`onNoSheet`): notice
// off, list unlocked, the switch cancelled; the call itself keeps its real
// timeout.

import { useEffect, useRef, useState } from 'react';
import { Platform } from 'react-native';

import { probeSawSheet, useCurrentProbe, type Probe } from '@/lib/hooks/use-language-switch';

export const NOTICE_DELAY_MS = 300;

/* A probe for a pack that is already there settles in well under
   NOTICE_DELAY_MS, with no sheet. Waiting it out keeps the notice from
   flashing in that case. */

/**
 * A probe this far in with no sign of Apple's sheet is not going to show one
 * (a call left over from an earlier attempt can hold the native host). The
 * reader is let go; the call itself keeps its real 90s / 20s timeout.
 */
export const NO_SHEET_MS = 8000;

/**
 * The notice's guards. `noticeCode` is the language to show the notice for
 * (null: no notice); `gaveUp` is the probe the host stopped waiting on.
 * `cancel` is the host's switch cancel; `onNoSheet` says why it was let go.
 */
export function useLanguageDownloadNotice(cancel: () => void, onNoSheet: (code: string) => void) {
    const probe = useCurrentProbe();
    const [gaveUp, setGaveUp] = useState<Probe | null>(null);
    const live = Platform.OS === 'ios' && probe && probe !== gaveUp ? probe.code : null;
    const cancelRef = useRef(cancel);
    cancelRef.current = cancel;
    const onNoSheetRef = useRef(onNoSheet);
    onNoSheetRef.current = onNoSheet;

    const [noticeCode, setNoticeCode] = useState<string | null>(null);
    useEffect(() => {
        if (!live) {
            setNoticeCode(null);
            return;
        }
        const id = setTimeout(() => setNoticeCode(live), NOTICE_DELAY_MS);
        return () => clearTimeout(id);
    }, [live, probe]);

    // No-sheet fallback. Apple's sheet sends JS no event; iOS reporting the app
    // not active is the one outside sign of it, and a probe that has seen it is
    // waiting on the reader, so it is never cut short. The probe itself watches
    // AppState from the moment its call starts (probeSawSheet): a listener
    // added here, after the page re-rendered, missed a short inactive blip and
    // gave up while the sheet was still up.
    useEffect(() => {
        if (!live || !probe) return;
        const id = setTimeout(() => {
            if (probeSawSheet(probe)) return;
            setGaveUp(probe);
            cancelRef.current();
            onNoSheetRef.current(live);
        }, NO_SHEET_MS);
        return () => clearTimeout(id);
    }, [live, probe]);

    return { noticeCode, gaveUp };
}

