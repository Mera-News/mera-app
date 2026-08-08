import React from 'react';
import { Modal, StyleSheet, View } from 'react-native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';

import { GluestackUIProvider } from '@/components/ui/gluestack-ui-provider';
import { PRE_AUTH_CHAPTER_ID } from '@/lib/tutorials/chapters';
import TutorialPlayer from './TutorialPlayer';

interface TutorialModalHostProps {
    readonly visible: boolean;
    readonly onClose: () => void;
}

/**
 * The PRE-AUTH host. `app/login.tsx` sits outside the logged-in stack, so there
 * is no route to push — and a Modal closes back to the exact `AuthScreen` view
 * mode (email entry or previous-user) the reader was in.
 *
 * Cloned from `components/custom/VideoPlayerModal.tsx:37` for the flags that
 * matter: `presentationStyle="overFullScreen"` + `transparent` +
 * `statusBarTranslucent`, and its own `GluestackUIProvider mode="dark"` because
 * an RN Modal is a SEPARATE NATIVE WINDOW and does not inherit context styling
 * from the tree that rendered it.
 *
 * ⚠️ That same separate-window fact is why the POST-auth host is a pushed route
 * instead: `FloatingChatHost` is mounted as a sibling after the logged-in
 * `<Stack>`, so a Modal would paint above it and "Ask Mera" would expand the
 * popover invisibly behind the tutorial. Nothing here needs to handle that,
 * because the player is mounted with `enableAskMera={false}` — there is no
 * session before login, so there is no agent to ask.
 *
 * ⚠️ The `GestureHandlerRootView` is not decoration. Gesture handling does not
 * reach modal content on Android without one. The interactions are all
 * tap-based precisely so nothing depends on it, but the `ScrollView` inside
 * `SlideView` does, and a slide that will not scroll on Android is a silent
 * failure on exactly the devices least likely to be tested first.
 */
const TutorialModalHost: React.FC<TutorialModalHostProps> = ({ visible, onClose }) => (
    <Modal
        visible={visible}
        animationType="fade"
        presentationStyle="overFullScreen"
        transparent
        statusBarTranslucent
        onRequestClose={onClose}
    >
        <GluestackUIProvider mode="dark">
            <GestureHandlerRootView style={styles.root}>
                <View style={styles.page}>
                    {visible ? (
                        <TutorialPlayer
                            chapterId={PRE_AUTH_CHAPTER_ID}
                            onClose={onClose}
                            enableAskMera={false}
                        />
                    ) : null}
                </View>
            </GestureHandlerRootView>
        </GluestackUIProvider>
    </Modal>
);

const styles = StyleSheet.create({
    root: { flex: 1 },
    // The app is dark-only; an opaque page under a `transparent` Modal is what
    // stops the login screen showing through the copy.
    page: { flex: 1, backgroundColor: '#000000' },
});

export default TutorialModalHost;
