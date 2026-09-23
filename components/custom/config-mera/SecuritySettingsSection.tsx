import PinLockScreen from '@/components/custom/auth/PinLockScreen';
import PinSetupScreen from '@/components/custom/auth/PinSetupScreen';
import { GlassPanel } from '@/components/custom/GlassSurface';
import { GluestackUIProvider } from '@/components/ui/gluestack-ui-provider';
import { HStack } from '@/components/ui/hstack';
import { Pressable } from '@/components/ui/pressable';
import { Spinner } from '@/components/ui/spinner';
import { Switch } from '@/components/ui/switch';
import { Text } from '@/components/ui/text';
import { Toast, ToastDescription, ToastTitle, useToast } from '@/components/ui/toast';
import { VStack } from '@/components/ui/vstack';
import logger from '@/lib/logger';
import { usePinStore } from '@/lib/stores/pin-store';
import { MaterialIcons } from '@expo/vector-icons';
import React, { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Modal, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

/**
 * Settings > Security: the PIN lock, directly in the Settings list.
 *
 * This is the ONLY surface that may turn the lock on (mera-app-persona
 * invariant 7). It used to live inside Display, which is where nobody looked
 * for it. The flows (set a first PIN, verify then change it) take over the
 * whole screen, so they open in a full-screen Modal over the Settings tab
 * rather than as a route: no new route, and the tab underneath keeps its
 * scroll position.
 *
 * Turning the lock ON means choosing a PIN first; the flag is written only
 * once a fresh record exists, so a cancelled setup leaves it off. Turning it
 * OFF is direct.
 */
type Flow = 'none' | 'enable' | 'verify' | 'set';

const SecuritySettingsSection: React.FC = () => {
    const { t } = useTranslation();
    const toast = useToast();
    const insets = useSafeAreaInsets();
    const lockEnabled = usePinStore((s) => s.lockEnabled);
    const setLockEnabled = usePinStore((s) => s.setLockEnabled);
    const [flow, setFlow] = useState<Flow>('none');
    // Guards the switch against a second tap while the keychain write from the
    // first is still in flight.
    const [lockBusy, setLockBusy] = useState(false);
    // The verify then set journey is two sequential PIN hashes; logged as one.
    const changePinStartRef = useRef(0);

    const showToast = (title: string, description: string) => {
        toast.show({
            placement: 'top',
            render: () => (
                <Toast action="success" variant="solid">
                    <ToastTitle>{title}</ToastTitle>
                    <ToastDescription>{description}</ToastDescription>
                </Toast>
            ),
        });
    };

    const handleLockToggle = async () => {
        if (lockBusy) return;
        if (!lockEnabled) {
            setFlow('enable');
            return;
        }
        setLockBusy(true);
        try {
            await setLockEnabled(false);
            showToast(t('security.lockDisabledTitle'), t('security.lockDisabledDescription'));
        } catch (err) {
            logger.captureException(err, {
                tags: { screen: 'SecuritySettingsSection', method: 'handleLockToggle' },
            });
        } finally {
            setLockBusy(false);
        }
    };

    // PinSetupScreen has already persisted the new record; what is left is
    // recording the opt-in.
    const handleEnableComplete = async () => {
        setLockBusy(true);
        try {
            await setLockEnabled(true);
            showToast(t('security.lockEnabledTitle'), t('security.lockEnabledDescription'));
        } catch (err) {
            logger.captureException(err, {
                tags: { screen: 'SecuritySettingsSection', method: 'handleEnableComplete' },
            });
        } finally {
            setFlow('none');
            setLockBusy(false);
        }
    };

    const handleNewPinComplete = () => {
        logger.info(
            `[pin-timing] SecuritySettingsSection submit→done ${Date.now() - changePinStartRef.current}ms`,
        );
        setFlow('none');
        showToast(t('security.pinChangedTitle'), t('security.pinChangedDescription'));
    };

    const flowScreen = () => {
        if (flow === 'enable') {
            return (
                <PinSetupScreen
                    onComplete={handleEnableComplete}
                    onCancel={() => setFlow('none')}
                    title={t('security.setPinTitle')}
                    subtitle={t('security.setPinSubtitle')}
                />
            );
        }
        if (flow === 'verify') {
            // PinLockScreen has no cancel of its own (it is the launch lock),
            // and inside a Modal there is no swipe back on iOS, so without this
            // a user who cannot recall the current PIN is stuck here.
            return (
                <View style={styles.page}>
                    <PinLockScreen
                        onUnlock={() => setFlow('set')}
                        showForgot={false}
                        title={t('security.verifyCurrentTitle')}
                        subtitle={t('security.verifyCurrentSubtitle')}
                    />
                    <Pressable
                        testID="pin-verify-cancel"
                        onPress={() => setFlow('none')}
                        accessibilityRole="button"
                        hitSlop={12}
                        style={[styles.cancel, { top: insets.top + 12 }]}
                    >
                        <Text className="text-base text-white">{t('common.cancel')}</Text>
                    </Pressable>
                </View>
            );
        }
        if (flow === 'set') {
            return (
                <PinSetupScreen
                    onComplete={handleNewPinComplete}
                    onCancel={() => setFlow('none')}
                    title={t('security.newPinTitle')}
                    subtitle={t('security.newPinSubtitle')}
                />
            );
        }
        return null;
    };

    return (
        <VStack>
            <GlassPanel radius={8} className="mb-3" fallbackClassName="border border-gray-700 bg-transparent">
                <HStack className="items-center justify-between py-3 px-4">
                    <HStack space="md" className="items-center flex-1 pr-3">
                        <MaterialIcons
                            name={lockEnabled ? 'lock' : 'lock-open'}
                            size={20}
                            color={lockEnabled ? '#10b981' : '#9ca3af'}
                        />
                        <VStack className="flex-1">
                            <Text className="text-base text-white">{t('security.requirePinTitle')}</Text>
                            <Text size="sm" className="text-gray-400 mt-0.5">
                                {t('security.requirePinDescription')}
                            </Text>
                        </VStack>
                    </HStack>
                    {lockBusy ? (
                        <Spinner size="small" />
                    ) : (
                        <Switch
                            testID="lock-switch"
                            value={lockEnabled}
                            onToggle={handleLockToggle}
                            size="md"
                        />
                    )}
                </HStack>
            </GlassPanel>

            {/* Only meaningful while the lock is on; with it off there is no
                record to change. */}
            {lockEnabled && (
                <GlassPanel radius={8} className="mb-3" fallbackClassName="border border-gray-700 bg-transparent">
                    <Pressable
                        testID="settings-row-change-pin"
                        accessibilityRole="button"
                        className="flex-row items-center justify-between py-3 px-4"
                        onPress={() => {
                            changePinStartRef.current = Date.now();
                            setFlow('verify');
                        }}
                    >
                        <Text className="text-base text-white">{t('security.changePin')}</Text>
                        <MaterialIcons name="chevron-right" size={20} color="#999999" />
                    </Pressable>
                </GlassPanel>
            )}

            {/* An RN Modal is a separate native window: it gets its own dark
                provider and an opaque page, the TutorialModalHost recipe. */}
            <Modal
                visible={flow !== 'none'}
                animationType="slide"
                presentationStyle="overFullScreen"
                transparent
                statusBarTranslucent
                onRequestClose={() => setFlow('none')}
            >
                <GluestackUIProvider mode="dark">
                    <View style={styles.page}>{flowScreen()}</View>
                </GluestackUIProvider>
            </Modal>
        </VStack>
    );
};

const styles = StyleSheet.create({
    page: { flex: 1, backgroundColor: '#000000' },
    cancel: { position: 'absolute', left: 20, paddingVertical: 8, paddingHorizontal: 4 },
});

export default SecuritySettingsSection;
