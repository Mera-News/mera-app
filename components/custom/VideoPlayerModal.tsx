import { Box } from '@/components/ui/box';
import { GluestackUIProvider } from '@/components/ui/gluestack-ui-provider';
import { Pressable } from '@/components/ui/pressable';
import { Spinner } from '@/components/ui/spinner';
import { Text } from '@/components/ui/text';
import { openInAppBrowser } from '@/lib/web-browser-utils';
import { MaterialIcons } from '@expo/vector-icons';
import { useEvent } from 'expo';
import { useVideoPlayer, VideoView } from 'expo-video';
import React from 'react';
import { Modal } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

interface VideoPlayerModalProps {
    /** Whether the modal is shown. The player is mounted only while visible. */
    visible: boolean;
    /** Direct media URL (e.g. an .mp4). */
    uri: string;
    /** Called when the user dismisses the player. */
    onClose: () => void;
}

/**
 * Full-screen in-app video player. Plays a direct media URL with expo-video
 * instead of bouncing the user out to an external browser. Used for the
 * "How to translate" guide, which is referenced from several screens.
 *
 * The actual player lives in an inner component so the native player is
 * created on open and torn down on close (playback restarts each time, and we
 * don't hold a decoder while the modal is hidden).
 */
const VideoPlayerModal: React.FC<VideoPlayerModalProps> = ({ visible, uri, onClose }) => {
    return (
        <Modal
            visible={visible}
            animationType="fade"
            presentationStyle="overFullScreen"
            transparent
            statusBarTranslucent
            onRequestClose={onClose}
        >
            <GluestackUIProvider mode="dark">
                {visible ? <PlayerContent uri={uri} onClose={onClose} /> : null}
            </GluestackUIProvider>
        </Modal>
    );
};

const PlayerContent: React.FC<{ uri: string; onClose: () => void }> = ({ uri, onClose }) => {
    const insets = useSafeAreaInsets();
    const player = useVideoPlayer(uri, (p) => {
        p.loop = false;
        p.play();
    });

    const { status } = useEvent(player, 'statusChange', { status: player.status });

    return (
        <Box className="flex-1 bg-black items-center justify-center">
            <VideoView
                style={{ width: '100%', height: '100%' }}
                player={player}
                contentFit="contain"
                allowsPictureInPicture
                nativeControls
            />

            {status === 'loading' && (
                <Box className="absolute inset-0 items-center justify-center">
                    <Spinner size="large" />
                </Box>
            )}

            {status === 'error' && (
                <Box className="absolute inset-0 items-center justify-center p-6">
                    <MaterialIcons name="error-outline" size={40} color="#EF4444" />
                    <Text className="text-white mt-3 text-center">
                        Could not play the video.
                    </Text>
                    <Pressable
                        onPress={() => {
                            onClose();
                            openInAppBrowser(uri).catch(() => {});
                        }}
                        className="mt-4 bg-gray-800 rounded-lg px-5 py-3"
                    >
                        <Text className="text-violet-400 font-medium">Open in browser</Text>
                    </Pressable>
                </Box>
            )}

            {/* Close button */}
            <Box style={{ position: 'absolute', right: 12, top: insets.top + 12 }}>
                <Pressable
                    onPress={onClose}
                    hitSlop={12}
                    accessibilityRole="button"
                    accessibilityLabel="Close video"
                    className="bg-gray-900/80 rounded-full p-3 shadow-hard-2"
                >
                    <MaterialIcons name="close" size={24} color="#ffffff" />
                </Pressable>
            </Box>
        </Box>
    );
};

export default VideoPlayerModal;
