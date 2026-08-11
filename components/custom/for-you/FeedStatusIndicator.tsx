// The feed pipeline's status, in one glyph, inline beside the screen title.
//
// This replaces a full-width indeterminate bar that sat under the title on both
// tabs. The bar was doing real work — it was also the only place a sync error or
// a hit daily limit surfaced — but it read as "something is arriving", which is
// what turned the Feed into a thing you check rather than a thing you read. The
// information survives; the billboard does not.
//
// Three visible states, one slot, always in the same place, so the shape of the
// header never changes as the pipeline moves through them:
//   processing → an orange spinner
//   error      → a red warning glyph
//   limited    → the same glyph in amber
// `deferred` and `idle` render nothing at all, and nothing is left to tap.
//
// The old animated segment had to be gated on `useAnimationsActive()` because it
// lived inside a real UIVisualEffectView and a blur re-samples its backdrop on
// every frame that backdrop changes — an unattended shimmer kept a full-screen
// blur recomputing behind whatever the user was reading. `ActivityIndicator` is
// a native view driven off the JS thread and this sits outside the GlassPlate's
// subtree, so that gate is gone rather than reproduced.

import { Pressable } from '@/components/ui/pressable';
import { Spinner } from '@/components/ui/spinner';
import { isStatusVisible, type FeedStatusMode } from '@/lib/feed-status-mode';
import { MaterialIcons } from '@expo/vector-icons';
import React from 'react';
import { useTranslation } from 'react-i18next';

/** primary-400 — the accent the rest of this header already uses. */
const ACCENT = 'rgb(231, 138, 83)';
const ERROR = '#F87171';
const WARN = '#FBBF24';

export interface FeedStatusIndicatorProps {
    readonly mode: FeedStatusMode;
    /** Whether the detail panel this opens is currently showing. */
    readonly expanded: boolean;
    readonly onPress: () => void;
    readonly testID: string;
}

export const FeedStatusIndicator: React.FC<FeedStatusIndicatorProps> = ({
    mode,
    expanded,
    onPress,
    testID,
}) => {
    const { t } = useTranslation();

    if (!isStatusVisible(mode)) return null;

    return (
        <Pressable
            testID={testID}
            onPress={onPress}
            // 12 is the header-chrome convention (the bell, the drill-down back
            // button); the glyph itself is only ~20pt.
            hitSlop={12}
            accessibilityRole="button"
            accessibilityState={{ expanded }}
            accessibilityLabel={t(expanded ? 'feedStatus.collapseA11y' : 'feedStatus.openA11y')}
            className="items-center justify-center"
        >
            {mode === 'processing' ? (
                <Spinner size="small" color={ACCENT} />
            ) : (
                <MaterialIcons
                    name="error-outline"
                    size={20}
                    color={mode === 'error' ? ERROR : WARN}
                />
            )}
        </Pressable>
    );
};

export default FeedStatusIndicator;
