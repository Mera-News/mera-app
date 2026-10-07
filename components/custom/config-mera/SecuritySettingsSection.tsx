import PinLockScreen from '@/components/custom/auth/PinLockScreen';
import PinSetupScreen from '@/components/custom/auth/PinSetupScreen';
import { Group, Help, Row } from '@/components/custom/you/rows';
import { useColors } from '@/lib/theme/tokens';
import { GluestackUIProvider } from '@/components/ui/gluestack-ui-provider';
import { Pressable } from '@/components/ui/pressable';
import { Spinner } from '@/components/ui/spinner';
import { Switch } from '@/components/ui/switch';
import { Text } from '@/components/ui/text';
import { Toast, ToastDescription, ToastTitle, useToast } from '@/components/ui/toast';
import logger from '@/lib/logger';
import { usePinStore } from '@/lib/stores/pin-store';
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
    const colors = useColors();
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
                <View style={[styles.page, { backgroundColor: colors.base }]}>
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
                        <Text className="text-base text-ink">{t('common.cancel')}</Text>
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
        <View style={{ gap: 10 }}>
            <Help>{t('appLock.intro')}</Help>
            <Group>
                <Row
                    title={t('security.requirePinTitle')}
                    trailing={
                        lockBusy ? (
                            <Spinner size="small" />
                        ) : (
                            <Switch testID="lock-switch" value={lockEnabled} onToggle={handleLockToggle} size="md" />
                        )
                    }
                />
                {/* Only meaningful while the lock is on: with it off there is
                    no record to change. */}
                {lockEnabled ? (
                    <Row
                        testID="settings-row-change-pin"
                        title={t('security.changePin')}
                        onPress={() => {
                            changePinStartRef.current = Date.now();
                            setFlow('verify');
                        }}
                    />
                ) : null}
            </Group>
            {/* Static text, never a route to /pin-setup (invariant 7). C3 copy. */}
            <Help>{t('appLock.forgot')}</Help>

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
                <GluestackUIProvider>
                    <View style={[styles.page, { backgroundColor: colors.base }]}>{flowScreen()}</View>
                </GluestackUIProvider>
            </Modal>
        </View>
    );
};

const styles = StyleSheet.create({
    page: { flex: 1 },
    cancel: {
        position: 'absolute',
        left: 20,
        minWidth: 44,
        minHeight: 44,
        justifyContent: 'center',
        paddingHorizontal: 4,
    },
});

export default SecuritySettingsSection;
