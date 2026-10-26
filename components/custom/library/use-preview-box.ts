// Where StatsShareModal may sit, in window points: under the header, above
// the tab bar. The screen's own bottom in the window anchors both bottoms (on
// iOS the tab content runs under the bar; on Android it ends at it). Shared by
// the Activity page and the detail screens that share one card image.

import type { PreviewBox } from '@/components/custom/share-stats/StatsShareModal';
import { useMeraButtonBottom, useTabBarClearance } from '@/lib/navigation/tab-bar';
import { useCallback, useRef, useState } from 'react';
import { useWindowDimensions, type View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

/** Under the page strip's pill track (safe area + 47): the preview's top. */
const PREVIEW_TOP = 52;

export function usePreviewBox(): { rootRef: React.RefObject<View | null>; onLayout: () => void; box: PreviewBox } {
    const insets = useSafeAreaInsets();
    const tabClearance = useTabBarClearance();
    const meraBottom = useMeraButtonBottom();
    const { height: screenH } = useWindowDimensions();
    const rootRef = useRef<View>(null);
    const [pageBottomGap, setPageBottomGap] = useState(0);
    const onLayout = useCallback(() => {
        rootRef.current?.measureInWindow((_x, y, _w, h) => {
            if (Number.isFinite(y) && h > 0) setPageBottomGap(Math.max(0, screenH - (y + h)));
        });
    }, [screenH]);
    return {
        rootRef,
        onLayout,
        box: {
            top: insets.top + PREVIEW_TOP,
            bottom: pageBottomGap + tabClearance,
            meraBottom: pageBottomGap + meraBottom,
        },
    };
}
