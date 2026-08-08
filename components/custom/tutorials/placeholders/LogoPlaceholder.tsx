import React from 'react';
import { StyleSheet, View } from 'react-native';

import MeraLogo from '@/components/custom/MeraLogo';
import { SCENE_HEIGHT, TUTORIAL_ACCENT_EDGE, TUTORIAL_ACCENT_SOFT } from '../theme';

/**
 * `{ kind: 'logo' }` — the animated Mera mark inside a soft disc.
 *
 * FORBIDDEN in chapter `welcome` (the pre-auth one) by explicit user
 * instruction; `lib/tutorials/__tests__/chapters.test.ts` asserts it, so the
 * rule does not rest on this comment.
 *
 * `MeraLogo animated` already owns its own focus/foreground gate and its own
 * reanimated hooks (see that file's header), so there is nothing to animate
 * here — this is layout only, and deliberately hook-free.
 */
const LogoPlaceholder: React.FC = () => (
    <View style={styles.root} pointerEvents="none">
        <View style={styles.disc}>
            <MeraLogo size={104} animated />
        </View>
    </View>
);

const DISC = 148;

const styles = StyleSheet.create({
    root: {
        height: SCENE_HEIGHT,
        alignItems: 'center',
        justifyContent: 'center',
    },
    disc: {
        width: DISC,
        height: DISC,
        borderRadius: DISC / 2,
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: TUTORIAL_ACCENT_SOFT,
        borderWidth: 1,
        borderColor: TUTORIAL_ACCENT_EDGE,
    },
});

export default LogoPlaceholder;
