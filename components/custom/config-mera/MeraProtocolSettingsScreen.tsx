import AbstractGradientBackdrop from '@/components/custom/AbstractGradientBackdrop';
import { Box } from '@/components/ui/box';
import { Button, ButtonText } from '@/components/ui/button';
import { GluestackUIProvider } from '@/components/ui/gluestack-ui-provider';
import { HStack } from '@/components/ui/hstack';
import { Modal, ModalBackdrop, ModalBody, ModalContent, ModalFooter, ModalHeader } from '@/components/ui/modal';
import { Pressable } from '@/components/ui/pressable';
import { Progress, ProgressFilledTrack } from '@/components/ui/progress';
import { Spinner } from '@/components/ui/spinner';
import { Text } from '@/components/ui/text';
import { VStack } from '@/components/ui/vstack';
import { ProcessingMode } from '@/lib/generated/graphql-types';
import {
    cancelModelDownload,
} from '@/lib/mera-protocol-toolkit/core/downloadService';
import {
    MODEL_CATALOG,
} from '@/lib/mera-protocol-toolkit/core/model-catalog';
import {
    averageMs,
    hasAnyStat,
} from '@/lib/mera-protocol-toolkit/core/inference-stats';
import { Switch } from '@/components/ui/switch';
import { AttestationVerificationRow } from '@/components/custom/config-mera/AttestationVerificationRow';
import { onDeviceSubtitleKind } from '@/components/custom/config-mera/on-device-subtitle';
import BetaBadge from '@/components/custom/BetaBadge';
import { MaterialIcons } from '@expo/vector-icons';
import { useLocalSearchParams } from 'expo-router';
import React, { useRef } from 'react';
import {
    AccessibilityInfo,
    findNodeHandle,
    type LayoutChangeEvent,
    Linking,
    Platform,
    ScrollView,
    StyleSheet,
    View,
} from 'react-native';
import { protocolFocusPlan } from './protocol-focus';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTranslation } from 'react-i18next';
import DrillDownHeader from '@/components/custom/config-panel/DrillDownHeader';
import { Group, GroupLabel, Help, Row } from '@/components/custom/you/rows';
import { tint, useColors } from '@/lib/theme/tokens';
import {
    BG_REFRESH_TITLE_KEY,
    bgRefreshDescriptionKey,
} from '@/lib/background/bg-refresh-ui';
import { useListEndClearance } from '@/lib/navigation/tab-bar';
import { useMeraProtocolSettings } from './useMeraProtocolSettings';

interface MeraProtocolSettingsScreenProps {
    onBack?: () => void;
}

const MeraProtocolSettingsScreen: React.FC<MeraProtocolSettingsScreenProps> = ({
    onBack,
}) => {
    const endClearance = useListEndClearance();
    const { t } = useTranslation();
    const colors = useColors();
    const {
        isLoading,
        isUpdatingMode,
        requirementsResult,
        showRequirements,
        setShowRequirements,
        showDeleteModelConfirm,
        setShowDeleteModelConfirm,
        isDeletingModel,
        isSwitchingModel,
        pendingSwitchTo,
        setPendingSwitchTo,
        processingMode,
        isOnDevice,
        selectedModelId,
        modelState,
        downloadProgress,
        store,
        webSearchInChat,
        currentModel,
        inferenceStats,
        deviceSupported,
        onDeviceIntent,
        bgRefreshEnabled,
        toggleBgRefresh,
        handleDownloadModel,
        handleDeleteModel,
        confirmDeleteModel,
        confirmSwitchModel,
        selectModel,
        getModelStatusText,
        getModelStatusColor,
        selectMode,
    } = useMeraProtocolSettings();
    const insets = useSafeAreaInsets();

    // `?focus=on-device` (the reading meter's "on this phone" link): once per
    // mount, scroll the On this phone row into view and give it screen-reader focus.
    const { focus } = useLocalSearchParams<{ focus?: string }>();
    const scrollRef = useRef<ScrollView>(null);
    // Two layout events feed protocolFocusPlan: the section's y within the scroll
    // content, and the row's native tag from the row's OWN layout event (the kit
    // Pressable's ref is not a native component, so it cannot be measured).
    const focusState = useRef<{ done: boolean; sectionY: number | null; rowTag: number | null }>({
        done: false,
        sectionY: null,
        rowTag: null,
    });
    const tryFocusOnDeviceRow = () => {
        const plan = protocolFocusPlan({ focus, ...focusState.current });
        if (!plan || !scrollRef.current) return;
        focusState.current.done = true;
        scrollRef.current.scrollTo({ y: plan.scrollY, animated: false });
        AccessibilityInfo.setAccessibilityFocus(plan.tag);
    };
    const onSectionLayout = (e: LayoutChangeEvent) => {
        focusState.current.sectionY = e.nativeEvent.layout.y;
        tryFocusOnDeviceRow();
    };
    const onDeviceRowLayout = (e: LayoutChangeEvent) => {
        // The event's currentTarget is the row's native host; nativeEvent.target is its tag.
        let tag: number | null = null;
        try {
            tag = findNodeHandle(e.currentTarget as never);
        } catch {
            tag = null;
        }
        if (tag == null) {
            const target = (e.nativeEvent as { target?: unknown }).target;
            tag = typeof target === 'number' ? target : null;
        }
        focusState.current.rowTag = tag;
        tryFocusOnDeviceRow();
    };

    // "Where Mera reads your news" (FinalSettings #11): On this phone is
    // always shown, for transparency, and disabled with the reason when the
    // phone can't run it; Private cloud says what it is. Beta stays on
    // On this phone (owner Y8).
    const modeRow = (mode: ProcessingMode) => {
        const onDevice = mode === ProcessingMode.OnDevice;
        const selected = onDevice ? onDeviceIntent : !onDeviceIntent;
        const cantRun = onDevice && deviceSupported === false;
        const title = onDevice ? t('you.settings.onThisPhone') : t('you.settings.privateCloud');
        const subtitle = onDevice
            ? (onDeviceSubtitleKind(cantRun) === 'cantRun' ? t('meraProtocol.cantRun') : t('meraProtocol.onDeviceNeedsCloud'))
            : t('meraProtocol.encrypted');
        return (
            <Pressable
                key={mode}
                onLayout={onDevice ? onDeviceRowLayout : undefined}
                testID={onDevice ? 'mode-on-device' : 'mode-cloud'}
                onPress={() => selectMode(mode)}
                disabled={isUpdatingMode || cantRun}
                accessibilityRole="radio"
                accessibilityState={{ selected, checked: selected, disabled: isUpdatingMode || cantRun }}
                accessibilityLabel={[title, onDevice ? t('common.beta') : null, subtitle].filter(Boolean).join(', ')}
                style={{ flexDirection: 'row', alignItems: 'center', gap: 12, minHeight: 56, paddingVertical: 10, paddingHorizontal: 16, opacity: cantRun ? 0.45 : 1 }}
            >
                <MaterialIcons name={selected ? 'radio-button-checked' : 'radio-button-unchecked'} size={22} color={selected ? colors.accent : colors.ink3} />
                <View style={{ flex: 1 }}>
                    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                        <Text style={{ color: colors.ink, fontSize: 16 }}>{title}</Text>
                        {onDevice ? <BetaBadge /> : null}
                    </View>
                    {subtitle ? <Text style={{ color: colors.ink2, fontSize: 13, lineHeight: 18, marginTop: 2 }}>{subtitle}</Text> : null}
                </View>
            </Pressable>
        );
    };

    const renderContent = () => (
        <>
            <View onLayout={onSectionLayout} style={{ paddingHorizontal: 14, marginBottom: 20 }}>
                <View style={{ flexDirection: 'row', alignItems: 'center' }}>
                    <View style={{ flex: 1 }}>
                        <GroupLabel>{t('meraProtocol.whereReads')}</GroupLabel>
                    </View>
                    {isUpdatingMode ? <Spinner size="small" /> : null}
                </View>
                <Group>
                    {modeRow(ProcessingMode.OnDevice)}
                    {modeRow(ProcessingMode.Cloud)}
                </Group>
                <View style={{ marginTop: 8 }}>
                    <Help>{deviceSupported === false ? t('meraProtocol.explainerCant') : `${t('meraProtocol.explainerCan')} ${t('meraProtocol.explainerOnPhoneLimits')}`}</Help>
                </View>
            </View>

            {/* Model Management Section — only relevant when the user wants
                on-device AND the device can actually run it. Otherwise this
                whole concept is implementation detail the user shouldn't see. */}
            {onDeviceIntent && deviceSupported === true && (
                <>
                    <Box className="mx-5 mb-6 border-b border-line" />

                    <Box className="px-5 mb-6">
                        <HStack className="items-center justify-between mb-1">
                            <Text className="text-ink text-lg font-semibold">{t('meraProtocol.aiModel')}</Text>
                            {(modelState === 'downloaded' || modelState === 'ready') && (
                                <Pressable
                                    onPress={handleDeleteModel}
                                    className="bg-surface rounded-full p-2"
                                >
                                    <MaterialIcons name="delete-outline" size={20} color={colors.negative} />
                                </Pressable>
                            )}
                        </HStack>
                        <Text size="xs" className="text-ink-3 mb-3">
                            {t('meraProtocol.modelRequiredForOnDevice')}
                        </Text>

                        {/* Model picker: one model on disk at a time. */}
                        <Text size="xs" className="text-ink-2 mb-2">
                            {t('meraProtocol.chooseModel')}
                        </Text>
                        <VStack space="sm" className="mb-4">
                            {MODEL_CATALOG.map((entry) => {
                                const selected = entry.modelId === selectedModelId;
                                const locked = modelState === 'downloading' || isSwitchingModel;
                                return (
                                    <VStack key={entry.modelId} space="xs">
                                        <Pressable
                                            testID={`mera-protocol-model-option-${entry.modelId.replace(/^mera-/, '')}`}
                                            onPress={() => selectModel(entry)}
                                            disabled={locked}
                                            accessibilityRole="radio"
                                            accessibilityLabel={`${entry.label}, ${`${(entry.sizeBytes / 1e9).toFixed(1)} GB`}`}
                                            accessibilityState={{ selected, disabled: locked }}
                                            className={
                                                'rounded-lg px-4 py-3 border ' +
                                                (selected
                                                    ? 'border-positive bg-surface-raised'
                                                    : 'border-line bg-surface') +
                                                (locked && !selected ? ' opacity-50' : '')
                                            }
                                        >
                                            <HStack space="md" className="items-center">
                                                <MaterialIcons
                                                    name={selected ? 'radio-button-checked' : 'radio-button-unchecked'}
                                                    size={20}
                                                    color={selected ? colors.positive : colors.ink2}
                                                />
                                                <Text className={'flex-1 font-medium ' + (selected ? 'text-positive' : 'text-ink')}>
                                                    {entry.label}
                                                </Text>
                                                <Text size="xs" className="text-ink-2">
                                                    {`${(entry.sizeBytes / 1e9).toFixed(1)} GB`}
                                                </Text>
                                            </HStack>
                                        </Pressable>
                                        {/* A sibling of the row, never inside it: a link nested in a
                                            selectable row steals the row's accessibility activation. */}
                                        <Pressable
                                            testID={`mera-protocol-model-license-${entry.modelId.replace(/^mera-/, '')}`}
                                            onPress={() => { void Linking.openURL(entry.licenseUrl); }}
                                            accessibilityRole="link"
                                            hitSlop={6}
                                            className="self-start ml-4"
                                        >
                                            <Text size="xs" className="text-ink-3 underline">
                                                {t('meraProtocol.modelLicense', { license: entry.licenseName })}
                                            </Text>
                                        </Pressable>
                                    </VStack>
                                );
                            })}
                        </VStack>

                        {/* Model Status */}
                        <HStack space="md" className="items-center mb-4">
                            <Box
                                className="w-3 h-3 rounded-full"
                                style={{ backgroundColor: getModelStatusColor() }}
                            />
                            <Text className="text-ink-2 text-sm">{getModelStatusText()}</Text>
                        </HStack>

                        {/* Download Progress Bar */}
                        {modelState === 'downloading' && (
                            <Box className="mb-4">
                                <Progress value={downloadProgress} size="sm" className="mb-2">
                                    <ProgressFilledTrack />
                                </Progress>
                            </Box>
                        )}

                        {/* Action Buttons */}
                        <VStack space="md">
                            {modelState === 'not_downloaded' && (
                                <Button
                                    action="primary"
                                    variant="solid"
                                    size="md"
                                    onPress={handleDownloadModel}
                                >
                                    <MaterialIcons name="cloud-download" size={18} color={colors.ink} style={{ marginRight: 8 }} />
                                    <ButtonText>
                                        {t('meraProtocol.downloadModelNamed', { model: currentModel.label, size: `${(currentModel.sizeBytes / 1e9).toFixed(1)} GB` })}
                                    </ButtonText>
                                </Button>
                            )}

                            {/* Cancel Download stays enabled even when read-only: it aborts a
                                transfer the user already started (up to ~2.8GB), not a settings
                                change — disabling it would strand them mid-download. */}
                            {modelState === 'downloading' && (
                                <Button
                                    action="negative"
                                    variant="outline"
                                    size="md"
                                    onPress={cancelModelDownload}
                                >
                                    <MaterialIcons name="close" size={18} color={colors.negative} style={{ marginRight: 8 }} />
                                    <ButtonText className="text-negative">{t('meraProtocol.cancelDownload')}</ButtonText>
                                </Button>
                            )}

                            {modelState === 'error' && (
                                <Button
                                    action="primary"
                                    variant="solid"
                                    size="md"
                                    onPress={handleDownloadModel}
                                >
                                    <MaterialIcons name="refresh" size={18} color={colors.ink} style={{ marginRight: 8 }} />
                                    <ButtonText>{t('meraProtocol.retryDownload')}</ButtonText>
                                </Button>
                            )}
                        </VStack>

                        {/* Speed on this device: in memory only, never stored or sent. */}
                        {hasAnyStat(inferenceStats) && (
                            <VStack space="xs" className="mt-4" testID="mera-protocol-speed">
                                <Text className="text-ink text-sm font-semibold">
                                    {t('meraProtocol.speedTitle')}
                                </Text>
                                {inferenceStats.loadMs.text != null && (
                                    <Text size="xs" className="text-ink-2">
                                        {t('meraProtocol.speedLoad', { seconds: (inferenceStats.loadMs.text / 1000).toFixed(1) })}
                                    </Text>
                                )}
                                {inferenceStats.genTokPerSec != null && (
                                    <Text size="xs" className="text-ink-2">
                                        {t('meraProtocol.speedGeneration', { tokPerSec: inferenceStats.genTokPerSec })}
                                    </Text>
                                )}
                                {averageMs(inferenceStats.relevance) != null && (
                                    <Text size="xs" className="text-ink-2">
                                        {t('meraProtocol.speedRelevance', { ms: averageMs(inferenceStats.relevance) })}
                                    </Text>
                                )}
                                {averageMs(inferenceStats.reason) != null && (
                                    <Text size="xs" className="text-ink-2">
                                        {t('meraProtocol.speedReason', { ms: averageMs(inferenceStats.reason) })}
                                    </Text>
                                )}
                                <Text size="xs" className="text-ink-3">
                                    {t('meraProtocol.speedResetNote')}
                                </Text>
                            </VStack>
                        )}
                    </Box>
                </>
            )}

            {/* Background refresh. The copy follows the mode the run will
                actually use. */}
            <View style={{ paddingHorizontal: 14, marginBottom: 6 }} testID="mera-protocol-bg-refresh">
                <GroupLabel>{t('meraProtocol.whileClosed')}</GroupLabel>
                <Group>
                    <Row
                        title={t(BG_REFRESH_TITLE_KEY)}
                        subtitle={t(bgRefreshDescriptionKey(processingMode === ProcessingMode.OnDevice, Platform.OS))}
                        trailing={
                            <Switch
                                value={bgRefreshEnabled}
                                onToggle={toggleBgRefresh}
                                size="md"
                                testID="mera-protocol-bg-refresh-switch"
                            />
                        }
                    />
                </Group>
            </View>

            {/* Web search in chat (item 13) — ON by default since the
                web-search wave, and forced on once for every existing device
                (see mera-protocol-store's SETTING_WEB_SEARCH_FORCED_ON). The
                description states plainly that the query leaves the device, in
                the toggle itself rather than buried in the privacy block below:
                this is the one setting on this screen that sends anything to a
                third party, so the disclosure has to be where the switch is —
                and now that it is on by default, that disclosure is the only
                thing standing between the user and a surprise.

                It was also the one switch never gated by the free-tier
                read-only flag, because turning a privacy setting OFF must never
                sit behind a paywall. That flag is gone now, so the exception
                has nothing left to be an exception to. */}
            <View style={{ paddingHorizontal: 14, marginBottom: 20 }} testID="mera-protocol-web-search">
                <GroupLabel>{t('meraProtocol.chatGroup')}</GroupLabel>
                <Group>
                    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12, minHeight: 48, paddingVertical: 10, paddingHorizontal: 16 }}>
                        <View style={{ flex: 1 }}>
                            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                                <Text style={{ color: colors.ink, fontSize: 16 }}>{t('meraProtocol.webSearchTitle')}</Text>
                                <BetaBadge />
                            </View>
                            <Text style={{ color: colors.ink2, fontSize: 13, lineHeight: 18, marginTop: 2 }}>{t('meraProtocol.webSearchShort')}</Text>
                        </View>
                        <Switch
                            value={webSearchInChat}
                            onToggle={() => store.setWebSearchInChat(!webSearchInChat)}
                            size="md"
                            testID="mera-protocol-web-search-switch"
                        />
                    </View>
                </Group>
            </View>

            {/* Privacy Explainer */}
            {/* Privacy shows in green (FinalSettings #11). */}
            <View style={{ marginHorizontal: 14, marginBottom: 20, borderRadius: 16, padding: 16, gap: 4, overflow: 'hidden' }} testID="mera-protocol-private">
                <View style={[StyleSheet.absoluteFill, { backgroundColor: colors.positive, opacity: 0.12 }]} />
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                    <MaterialIcons name="verified-user" size={18} color={colors.positive} />
                    <Text style={{ color: colors.positive, fontSize: 16, fontWeight: '600' }}>{t('meraProtocol.staysPrivateTitle')}</Text>
                </View>
                <Text style={{ color: colors.ink2, fontSize: 14, lineHeight: 20 }}>{t('meraProtocol.staysPrivateBody')}</Text>
            </View>

            {/* Verify attestation — UNCONDITIONAL. This sits with the privacy
                explainer rather than under the on-device section because it is
                Cloud mode (the default) where attestation is what stands
                between the user's prompts and the operator. Hiding it behind a
                mode toggle would hide it from everyone it protects. */}
            <AttestationVerificationRow />

            {/* Device Capability Notice — only when the user has expressed intent
                to run on-device on a device that can't support it. Cloud-mode
                users (the default) never see this; Mera Protocol works fine for
                them via the Cloud TEE LLM regardless of device specs. */}
            {onDeviceIntent && requirementsResult && requirementsResult.supported === false && (
                <Box className="px-5 mb-6">
                    <Box className="p-4 rounded-lg border bg-surface border-negative">
                        <Pressable onPress={() => setShowRequirements(prev => !prev)}>
                            <HStack space="md" className="items-start">
                                <MaterialIcons
                                    name="warning"
                                    size={24}
                                    color={colors.negative}
                                    style={{ marginTop: 2 }}
                                />
                                <VStack className="flex-1">
                                    <Text className="text-base font-semibold mb-1 text-negative">
                                        {t('meraProtocol.deviceNotSupported')}
                                    </Text>
                                    <Text className="text-sm text-negative">
                                        {t('meraProtocol.deviceNotSupportedDescription')}
                                    </Text>
                                </VStack>
                                <MaterialIcons
                                    name={showRequirements ? 'keyboard-arrow-up' : 'keyboard-arrow-down'}
                                    size={24}
                                    color={colors.negative}
                                    style={{ marginTop: 2 }}
                                />
                            </HStack>
                        </Pressable>

                        {/* System Requirements (accordion) */}
                        {showRequirements && (
                            <VStack space="sm" className="mt-4 pt-4 border-t" style={{ borderTopColor: tint(colors.negative, 0.4) }}>
                                <HStack space="sm" className="items-center">
                                    <MaterialIcons
                                        name={requirementsResult.failedCheck === 'ram' ? 'cancel' : 'check-circle'}
                                        size={16}
                                        color={requirementsResult.failedCheck === 'ram' ? colors.negative : colors.positive}
                                    />
                                    <Text className="text-ink-2 text-sm">
                                        {t('meraProtocol.ramLabel')}{requirementsResult.deviceInfo.ramGB != null ? ` (yours: ${requirementsResult.deviceInfo.ramGB}GB)` : ''}
                                    </Text>
                                </HStack>
                                <HStack space="sm" className="items-center">
                                    <MaterialIcons
                                        name={requirementsResult.failedCheck === 'os_version' ? 'cancel' : 'check-circle'}
                                        size={16}
                                        color={requirementsResult.failedCheck === 'os_version' ? colors.negative : colors.positive}
                                    />
                                    <Text className="text-ink-2 text-sm">
                                        {Platform.OS === 'ios' ? t('meraProtocol.iosVersion') : t('meraProtocol.androidVersion')}{requirementsResult.deviceInfo.osVersion ? ` (yours: ${requirementsResult.deviceInfo.osVersion})` : ''}
                                    </Text>
                                </HStack>
                                {Platform.OS === 'ios' && (
                                    <HStack space="sm" className="items-center">
                                        <MaterialIcons
                                            name={requirementsResult.failedCheck === 'chip' ? 'cancel' : 'check-circle'}
                                            size={16}
                                            color={requirementsResult.failedCheck === 'chip' ? colors.negative : colors.positive}
                                        />
                                        <Text className="text-ink-2 text-sm">{t('meraProtocol.chipLabel')}</Text>
                                    </HStack>
                                )}
                                <HStack space="sm" className="items-center">
                                    <MaterialIcons
                                        name={requirementsResult.failedCheck === 'storage' ? 'cancel' : 'check-circle'}
                                        size={16}
                                        color={requirementsResult.failedCheck === 'storage' ? colors.negative : colors.positive}
                                    />
                                    <Text className="text-ink-2 text-sm">
                                        {t('meraProtocol.storageLabel')}{requirementsResult.deviceInfo.freeStorageGB != null ? ` (yours: ${requirementsResult.deviceInfo.freeStorageGB}GB free)` : ''}
                                    </Text>
                                </HStack>
                            </VStack>
                        )}
                    </Box>
                </Box>
            )}

            {/* Delete AI Model Confirmation Modal */}
            <Modal isOpen={showDeleteModelConfirm} onClose={() => setShowDeleteModelConfirm(false)} size="sm">
                <ModalBackdrop />
                <ModalContent>
                    <ModalHeader className="border-line pb-4">
                        <Text className="text-xl font-semibold text-negative">{t('meraProtocol.deleteTitle')}</Text>
                    </ModalHeader>
                    <ModalBody className="py-6">
                        <Text className="text-ink text-base leading-relaxed">
                            {t('meraProtocol.deleteModelDescription', { model: currentModel.label, size: `${(currentModel.sizeBytes / 1e9).toFixed(1)} GB` })}
                        </Text>
                    </ModalBody>
                    <ModalFooter className="border-t border-line pt-4">
                        <VStack className="w-full" space="md">
                            <Button
                                action="negative"
                                onPress={confirmDeleteModel}
                                disabled={isDeletingModel}
                                className="w-full"
                            >
                                <ButtonText>
                                    {isDeletingModel ? t('meraProtocol.deleting') : t('meraProtocol.deleteButton')}
                                </ButtonText>
                            </Button>
                            <Button
                                variant="outline"
                                action="secondary"
                                onPress={() => setShowDeleteModelConfirm(false)}
                                className="w-full"
                            >
                                <ButtonText>{t('common.cancel')}</ButtonText>
                            </Button>
                        </VStack>
                    </ModalFooter>
                </ModalContent>
            </Modal>

            {/* Switch Model Confirmation Modal */}
            <Modal isOpen={pendingSwitchTo !== null} onClose={() => setPendingSwitchTo(null)} size="sm">
                <ModalBackdrop />
                <ModalContent>
                    <ModalHeader className="border-line pb-4">
                        <Text className="text-xl font-semibold text-ink">{t('meraProtocol.switchModelTitle')}</Text>
                    </ModalHeader>
                    <ModalBody className="py-6">
                        <Text className="text-ink text-base leading-relaxed">
                            {t('meraProtocol.switchModelDescription', {
                                current: currentModel.label,
                                new: pendingSwitchTo?.label ?? '',
                            })}
                        </Text>
                    </ModalBody>
                    <ModalFooter className="border-t border-line pt-4">
                        <VStack className="w-full" space="md">
                            <Button
                                action="primary"
                                onPress={confirmSwitchModel}
                                isDisabled={isSwitchingModel}
                                className="w-full"
                                testID="mera-protocol-switch-model-confirm"
                            >
                                <ButtonText>{t('meraProtocol.switchModelConfirm')}</ButtonText>
                            </Button>
                            <Button
                                variant="outline"
                                action="secondary"
                                onPress={() => setPendingSwitchTo(null)}
                                className="w-full"
                            >
                                <ButtonText>{t('common.cancel')}</ButtonText>
                            </Button>
                        </VStack>
                    </ModalFooter>
                </ModalContent>
            </Modal>
        </>
    );

    // Loading state
    if (isLoading) {
        return (
            <GluestackUIProvider>
                <Box className="flex-1">
                    {/* Page background. Must be the FIRST child so it paints behind
                        everything else on the page. */}
                    <AbstractGradientBackdrop />

                    <Box style={{ paddingTop: insets.top }}>
                        <DrillDownHeader title={t('meraProtocol.title')} onBack={onBack} />
                    </Box>
                    <VStack className="flex-1 justify-center items-center">
                        <Spinner size="large" />
                    </VStack>
                </Box>
            </GluestackUIProvider>
        );
    }

    // Preferences mode
    // Keep `isOnDevice` referenced so eslint doesn't strip the selector.
    void isOnDevice;

    return (
        <GluestackUIProvider>
            <Box className="flex-1">
                {/* Page background. Must be the FIRST child so it paints behind
                    everything else on the page. */}
                <AbstractGradientBackdrop />

                <Box style={{ paddingTop: insets.top }}>
                    <DrillDownHeader title={t('meraProtocol.title')} onBack={onBack} />
                </Box>

                <ScrollView ref={scrollRef} className="flex-1" contentContainerStyle={{ paddingBottom: endClearance }}>
                    {renderContent()}
                </ScrollView>

            </Box>
        </GluestackUIProvider>
    );
};

export default MeraProtocolSettingsScreen;
