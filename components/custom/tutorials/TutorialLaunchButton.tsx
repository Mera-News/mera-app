import { MaterialIcons } from '@expo/vector-icons';
import React, { useCallback, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { hapticLight } from '@/lib/haptics';
import TutorialModalHost from './TutorialModalHost';
import { TUTORIAL_TEXT_DIM } from './theme';
import { useTutorialCopy } from './use-tutorial-copy';

/**
 * The login-screen entry point: a pill that opens the pre-auth chapter.
 *
 * It owns its OWN visibility state and its own Modal, so adding it to a login
 * view is a one-line change (`<TutorialLaunchButton />`) with no state to thread
 * through `AuthScreen` or `PreviousUserView`. Both views mount their own
 * instance; only one is on screen at a time.
 *
 * Shape borrowed from `PolicyPill` so it reads as part of the login screen's
 * existing quiet chrome rather than as a promotion.
 */
const TutorialLaunchButton: React.FC = () => {
    const t = useTutorialCopy();
    const [open, setOpen] = useState(false);

    const handleOpen = useCallback(() => {
        void hapticLight();
        setOpen(true);
    }, []);

    const handleClose = useCallback(() => setOpen(false), []);

    return (
        <View style={styles.wrap}>
            <Pressable
                testID="tutorial-launch"
                onPress={handleOpen}
                accessibilityRole="button"
                accessibilityLabel={t('tutorials.launchButton')}
                style={styles.pill}
            >
                <MaterialIcons name="school" size={15} color={TUTORIAL_TEXT_DIM} />
                <Text style={styles.label}>{t('tutorials.launchButton')}</Text>
            </Pressable>

            <TutorialModalHost visible={open} onClose={handleClose} />
        </View>
    );
};

const styles = StyleSheet.create({
    wrap: { alignItems: 'center' },
    pill: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 7,
        borderRadius: 999,
        borderWidth: StyleSheet.hairlineWidth,
        borderColor: 'rgba(255,255,255,0.18)',
        paddingHorizontal: 14,
        paddingVertical: 8,
    },
    label: {
        color: TUTORIAL_TEXT_DIM,
        fontSize: 13,
        fontWeight: '500',
    },
});

export default TutorialLaunchButton;
