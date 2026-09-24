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
import { Toast, ToastDescription, ToastTitle, useToast } from '@/components/ui/toast';
import { VStack } from '@/components/ui/vstack';
import { AccountService } from '@/lib/account-service';
import { authClient } from '@/lib/auth-client';
import { ProcessingMode } from '@/lib/generated/graphql-types';
import {
    cancelModelDownload,
    isDownloadInProgress,
    startModelDownload,
} from '@/lib/mera-protocol-toolkit/core/downloadService';
import {
    deleteBaseModel,
    disposeModel,
    isModelDownloaded,
} from '@/lib/mera-protocol-toolkit/core/modelManager';
import { checkRequirements } from '@/lib/mera-protocol-toolkit/core/systemRequirements';
import {
    MODEL_CATALOG,
    catalogEntry,
    type ModelCatalogEntry,
} from '@/lib/mera-protocol-toolkit/core/model-catalog';
import {
    averageMs,
    resetInferenceStats,
    useInferenceStats,
} from '@/lib/mera-protocol-toolkit/core/inference-stats';
import type { SystemRequirementsResult } from '@/lib/mera-protocol-toolkit/types';
import {
    useDeepInterview,
    useDownloadProgress,
    useAutoCommunityFactCheck,
    useMeraProtocolStore,
    useModelState as useModelStateSelector,
    useProcessingMode,
    useRelevanceV4,
    useSelectedModelId,
    useShowExtractedMetadata,
    useWebSearchInChat,
} from '@/lib/stores/mera-protocol-store';
import { Switch } from '@/components/ui/switch';
import { AttestationVerificationRow } from '@/components/custom/config-mera/AttestationVerificationRow';
import BetaBadge from '@/components/custom/BetaBadge';
import { MaterialIcons } from '@expo/vector-icons';
import React, { useCallback, useEffect, useState } from 'react';
import { Linking, Platform, ScrollView } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTranslation } from 'react-i18next';
import DrillDownHeader from '@/components/custom/config-panel/DrillDownHeader';
import ProcessingModePill from './ProcessingModePill';

interface MeraProtocolSettingsScreenProps {
    onBack?: () => void;
    isOnboarding?: boolean;
    onNext?: () => void;
    initialMode?: ProcessingMode;
    onModeChange?: (mode: ProcessingMode) => void;
}

const MeraProtocolSettingsScreen: React.FC<MeraProtocolSettingsScreenProps> = ({
    onBack,
    isOnboarding = false,
    initialMode = ProcessingMode.Cloud,
    onModeChange,
}) => {
    const { t } = useTranslation();
    const [isLoading, setIsLoading] = useState(!isOnboarding);
    const [isUpdatingMode, setIsUpdatingMode] = useState(false);
    const [requirementsResult, setRequirementsResult] = useState<SystemRequirementsResult | null>(null);
    const [showRequirements, setShowRequirements] = useState(false);
    const [showDeleteModelConfirm, setShowDeleteModelConfirm] = useState(false);
    const [isDeletingModel, setIsDeletingModel] = useState(false);
    const [isSwitchingModel, setIsSwitchingModel] = useState(false);
    // The catalogue entry the user tapped while another model is on disk.
    const [pendingSwitchTo, setPendingSwitchTo] = useState<ModelCatalogEntry | null>(null);

    const processingMode = useProcessingMode();
    const isOnDevice = processingMode === ProcessingMode.OnDevice;
    const selectedModelId = useSelectedModelId();
    const modelState = useModelStateSelector();
    const downloadProgress = useDownloadProgress();
    const store = useMeraProtocolStore();
    const relevanceV4 = useRelevanceV4();
    const webSearchInChat = useWebSearchInChat();
    const deepInterview = useDeepInterview();
    const showExtractedMetadata = useShowExtractedMetadata();
    const autoCommunityFactCheck = useAutoCommunityFactCheck();

    const currentModel = catalogEntry(selectedModelId);
    const inferenceStats = useInferenceStats();
    const modelDownloaded = modelState === 'downloaded' || modelState === 'ready';

    const toast = useToast();
    const insets = useSafeAreaInsets();

    const deviceSupported = requirementsResult?.supported ?? null;
    const onDeviceAvailable = deviceSupported !== false && modelDownloaded;

    // Drives which sections are visible. The user can express intent to run
    // on-device even when the runtime preconditions (device + model) aren't
    // met yet — that's what reveals the relevant banner / download UI.
    // `processingMode` only flips to OnDevice once on-device is actually runnable.
    const [onDeviceIntent, setOnDeviceIntent] = useState(
        processingMode === ProcessingMode.OnDevice,
    );

    useEffect(() => {
        checkRequirements().then(setRequirementsResult);
    }, []);

    // Once the user has expressed intent to run on-device AND the runtime
    // preconditions are met (device supported + model downloaded), promote
    // their intent into the persisted processingMode. This lets the user
    // tap "On-device" once, download the model, and have it Just Work.
    useEffect(() => {
        if (!onDeviceIntent) return;
        if (processingMode === ProcessingMode.OnDevice) return;
        if (deviceSupported !== true) return;
        if (!modelDownloaded) return;

        if (isOnboarding) {
            store.setProcessingMode(ProcessingMode.OnDevice);
            onModeChange?.(ProcessingMode.OnDevice);
            return;
        }
        (async () => {
            try {
                const userId = await getCurrentUserId();
                await AccountService.updateProcessingMode(userId, ProcessingMode.OnDevice);
                store.setProcessingMode(ProcessingMode.OnDevice);
            } catch {
                // Server mutation failed — leave processingMode as-is. The user
                // can retry by tapping the on-device pill again.
            }
        })();
        // Reacts only to the intent/capability inputs listed; `store` and the
        // async helpers it calls are stable module/singleton refs, excluded
        // intentionally to avoid re-running the mutation on every render.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [onDeviceIntent, deviceSupported, modelDownloaded, processingMode]);

    useEffect(() => {
        if (isOnboarding) {
            store.setProcessingMode(initialMode);
            checkModelStatus();
            return;
        }
        loadSettings();
        // Run-once-on-mount branch keyed by isOnboarding; the loader/status
        // helpers are stable and excluded to keep this a mount-time effect.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [isOnboarding]);

    const getCurrentUserId = async (): Promise<string> => {
        const sessionData = await authClient.getSession();
        if (!sessionData?.data?.user?.id) {
            throw new Error('User not authenticated');
        }
        return sessionData.data.user.id;
    };

    const checkModelStatus = async () => {
        if (isDownloadInProgress()) return;
        try {
            const downloaded = await isModelDownloaded(selectedModelId);
            store.setModelState(downloaded ? 'downloaded' : 'not_downloaded');
        } catch {
            store.setModelState('not_downloaded');
        }
    };

    const loadSettings = async () => {
        try {
            const userId = await getCurrentUserId();
            const userPersona = await AccountService.getUserPersona(userId);
            if (userPersona?.processingMode) {
                const wantsOnDevice = userPersona.processingMode === ProcessingMode.OnDevice;
                setOnDeviceIntent(wantsOnDevice);
                // Never promote OnDevice without a model on disk (a retired model,
                // or one the OS evicted from Caches). Keep the intent so the picker
                // shows; the auto-promote effect flips the mode once a download
                // finishes.
                const runnable = !wantsOnDevice || (await isModelDownloaded(selectedModelId));
                store.setProcessingMode(runnable ? userPersona.processingMode : ProcessingMode.Cloud);
            }
            await checkModelStatus();
        } catch {
            toast.show({
                placement: 'top',
                render: () => (
                    <Toast action="error" variant="solid">
                        <ToastTitle>{t('meraProtocol.loadFailedTitle')}</ToastTitle>
                        <ToastDescription>{t('meraProtocol.loadFailedDescription')}</ToastDescription>
                    </Toast>
                ),
            });
        } finally {
            setIsLoading(false);
        }
    };

    const selectMode = async (mode: ProcessingMode) => {
        const wantsOnDevice = mode === ProcessingMode.OnDevice;

        // Always reflect intent locally — this is what drives the visibility
        // of the device-compatibility banner and the model-download section.
        setOnDeviceIntent(wantsOnDevice);

        // In onboarding, also bubble intent up so the wizard can gate the
        // "Next" button: tapping on-device must block progression until the
        // model is actually downloaded (or the user reverts to Cloud).
        if (isOnboarding) {
            onModeChange?.(mode);
        }

        // If on-device isn't runnable yet, the contextual UI we just revealed
        // (banner or download section) is the feedback. Don't persist or toast.
        if (wantsOnDevice && !onDeviceAvailable) return;
        if (mode === processingMode) return;

        setIsUpdatingMode(true);
        try {
            if (isOnboarding) {
                store.setProcessingMode(mode);
                // onModeChange already fired above to bubble intent up.
            } else {
                const userId = await getCurrentUserId();
                await AccountService.updateProcessingMode(userId, mode);
                store.setProcessingMode(mode);
            }

            toast.show({
                placement: 'top',
                render: () => (
                    <Toast action="success" variant="solid">
                        <ToastTitle>
                            {wantsOnDevice
                                ? t('meraProtocol.modeUpdatedOnDeviceTitle')
                                : t('meraProtocol.modeUpdatedCloudTitle')}
                        </ToastTitle>
                        <ToastDescription>
                            {wantsOnDevice
                                ? t('meraProtocol.modeUpdatedOnDeviceDescription')
                                : t('meraProtocol.modeUpdatedCloudDescription')}
                        </ToastDescription>
                    </Toast>
                ),
            });
        } catch {
            toast.show({
                placement: 'top',
                render: () => (
                    <Toast action="error" variant="solid">
                        <ToastTitle>{t('meraProtocol.settingUpdateFailedTitle')}</ToastTitle>
                        <ToastDescription>{t('meraProtocol.settingUpdateFailedDescription')}</ToastDescription>
                    </Toast>
                ),
            });
        } finally {
            setIsUpdatingMode(false);
        }
    };

    // Show toasts for download completion/failure while on this screen
    useEffect(() => {
        let prev = useMeraProtocolStore.getState().modelState;
        const unsub = useMeraProtocolStore.subscribe((state) => {
            const curr = state.modelState;
            if (prev === 'downloading' && curr === 'downloaded') {
                toast.show({
                    placement: 'top',
                    render: () => (
                        <Toast action="success" variant="solid">
                            <ToastTitle>{t('meraProtocol.dlCompleteTitle')}</ToastTitle>
                            <ToastDescription>{t('meraProtocol.dlCompleteDescription')}</ToastDescription>
                        </Toast>
                    ),
                });
            }
            if (prev === 'downloading' && curr === 'error') {
                toast.show({
                    placement: 'top',
                    render: () => (
                        <Toast action="error" variant="solid">
                            <ToastTitle>{t('meraProtocol.dlFailedTitle')}</ToastTitle>
                            <ToastDescription>{t('meraProtocol.dlFailedDescription')}</ToastDescription>
                        </Toast>
                    ),
                });
            }
            prev = curr;
        });
        return unsub;
    }, [toast, t]);

    const handleDownloadModel = useCallback(() => {
        if (isDownloadInProgress()) {
            toast.show({
                placement: 'top',
                render: () => (
                    <Toast action="info" variant="solid">
                        <ToastTitle>{t('meraProtocol.dlInProgressTitle')}</ToastTitle>
                        <ToastDescription>{t('meraProtocol.dlInProgressDescription')}</ToastDescription>
                    </Toast>
                ),
            });
            return;
        }
        startModelDownload({
            modelId: currentModel.modelId,
            modelUrl: currentModel.modelUrl,
            expectedChecksum: currentModel.expectedChecksum,
        });
        toast.show({
            placement: 'top',
            render: () => (
                <Toast action="info" variant="solid">
                    <ToastTitle>{t('meraProtocol.dlStartedTitle')}</ToastTitle>
                    <ToastDescription>{t('meraProtocol.dlStartedDescription')}</ToastDescription>
                </Toast>
            ),
        });
    }, [toast, currentModel, t]);

    const handleDeleteModel = useCallback(() => {
        setShowDeleteModelConfirm(true);
    }, []);

    const confirmDeleteModel = useCallback(async () => {
        setIsDeletingModel(true);
        setShowDeleteModelConfirm(false);
        try {
            await disposeModel();
            await deleteBaseModel(selectedModelId);
            store.setModelState('not_downloaded');
            store.setDownloadProgress(0);

            // If the user was on on-device mode, fall back to cloud — the model
            // they relied on is gone. Non-onboarding only; during onboarding
            // the server mutation hasn't fired yet.
            if (processingMode === ProcessingMode.OnDevice) {
                if (isOnboarding) {
                    store.setProcessingMode(ProcessingMode.Cloud);
                    onModeChange?.(ProcessingMode.Cloud);
                } else {
                    try {
                        const userId = await getCurrentUserId();
                        await AccountService.updateProcessingMode(userId, ProcessingMode.Cloud);
                    } catch {
                        // Server mutation failed — still update locally so the
                        // UI reflects reality. Next settings load will reconcile.
                    }
                    store.setProcessingMode(ProcessingMode.Cloud);
                }
            }
            // Also clear on-device intent so the download section collapses.
            setOnDeviceIntent(false);

            toast.show({
                placement: 'top',
                render: () => (
                    <Toast action="success" variant="solid">
                        <ToastTitle>{t('meraProtocol.modelDeletedTitle')}</ToastTitle>
                        <ToastDescription>{t('meraProtocol.modelDeletedDescription')}</ToastDescription>
                    </Toast>
                ),
            });
        } catch {
            toast.show({
                placement: 'top',
                render: () => (
                    <Toast action="error" variant="solid">
                        <ToastTitle>{t('meraProtocol.deleteFailedTitle')}</ToastTitle>
                        <ToastDescription>{t('meraProtocol.deleteFailedDescription')}</ToastDescription>
                    </Toast>
                ),
            });
        } finally {
            setIsDeletingModel(false);
        }
    }, [store, toast, selectedModelId, t, processingMode, isOnboarding, onModeChange]);

    // Mirrors confirmDeleteModel: the model the user relied on is leaving the
    // device, so on-device processing falls back to cloud until a new one lands.
    const fallBackToCloud = useCallback(async () => {
        if (processingMode !== ProcessingMode.OnDevice) return;
        if (isOnboarding) {
            store.setProcessingMode(ProcessingMode.Cloud);
            onModeChange?.(ProcessingMode.Cloud);
            return;
        }
        try {
            const userId = await getCurrentUserId();
            await AccountService.updateProcessingMode(userId, ProcessingMode.Cloud);
        } catch {
            // Server mutation failed. Still update locally so the UI reflects
            // reality; the next settings load will not re-promote OnDevice
            // without a model on disk.
        }
        store.setProcessingMode(ProcessingMode.Cloud);
        // Reacts only to the inputs listed; `store` and the async helpers are
        // stable module/singleton refs.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [processingMode, isOnboarding, onModeChange]);

    const selectModel = useCallback((entry: ModelCatalogEntry) => {
        if (entry.modelId === selectedModelId) return;
        if (modelState === 'downloading' || isSwitchingModel) return;
        // Only one model is ever on disk, so switching away from a downloaded
        // one deletes it. That is worth a confirm; picking before any download
        // is not.
        if (modelState === 'downloaded' || modelState === 'ready' || modelState === 'loading') {
            setPendingSwitchTo(entry);
            return;
        }
        store.setSelectedModelId(entry.modelId);
        store.setModelState('not_downloaded');
        store.setDownloadProgress(0);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [selectedModelId, modelState, isSwitchingModel]);

    const confirmSwitchModel = useCallback(async () => {
        const target = pendingSwitchTo;
        setPendingSwitchTo(null);
        if (!target) return;
        setIsSwitchingModel(true);
        try {
            await disposeModel();
            await deleteBaseModel(selectedModelId);
            store.setSelectedModelId(target.modelId);
            store.setModelState('not_downloaded');
            store.setDownloadProgress(0);
            resetInferenceStats();
            await fallBackToCloud();
        } catch {
            toast.show({
                placement: 'top',
                render: () => (
                    <Toast action="error" variant="solid">
                        <ToastTitle>{t('meraProtocol.deleteFailedTitle')}</ToastTitle>
                        <ToastDescription>{t('meraProtocol.deleteFailedDescription')}</ToastDescription>
                    </Toast>
                ),
            });
        } finally {
            setIsSwitchingModel(false);
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [pendingSwitchTo, selectedModelId, fallBackToCloud, toast, t]);

    const getModelStatusText = (): string => {
        switch (modelState) {
            case 'not_downloaded':
                return t('meraProtocol.notDownloaded');
            case 'downloading':
                return downloadProgress > 0
                    ? t('meraProtocol.downloading', { percent: Math.round(downloadProgress) })
                    : t('meraProtocol.starting');
            case 'downloaded':
                return t('meraProtocol.downloaded');
            case 'loading':
                return t('meraProtocol.loadingMemory');
            case 'ready':
                return t('meraProtocol.loaded');
            case 'error':
                return t('meraProtocol.errorOccurred');
            default:
                return t('meraProtocol.unknown');
        }
    };

    const getModelStatusColor = (): string => {
        switch (modelState) {
            case 'ready':
            case 'downloaded':
                return '#10b981';
            case 'downloading':
            case 'loading':
                return '#f59e0b';
            case 'error':
                return '#ef4444';
            default:
                return '#9ca3af';
        }
    };

    const renderModePill = (mode: ProcessingMode) => {
        const onDevicePill = mode === ProcessingMode.OnDevice;
        return (
            <ProcessingModePill
                key={mode}
                mode={mode}
                selected={onDevicePill ? onDeviceIntent : !onDeviceIntent}
                disabled={isUpdatingMode}
                onPress={() => selectMode(mode)}
            />
        );
    };

    const renderContent = () => (
        <>
            {/* Header text for onboarding */}
            {isOnboarding && (
                <VStack className="mb-8 px-5">
                    <Text className="text-3xl font-bold text-white text-center mb-3">
                        {t('meraProtocol.title')}
                    </Text>
                </VStack>
            )}

            {/* Processing Mode Segmented Control */}
            <Box className="px-5 mb-6">
                <HStack className="items-center justify-between mb-3">
                    <Text className="text-white text-lg font-semibold">
                        {t('meraProtocol.processingModeTitle')}
                    </Text>
                    {isUpdatingMode && <Spinner size="small" />}
                </HStack>
                <HStack space="sm">
                    {renderModePill(ProcessingMode.OnDevice)}
                    {renderModePill(ProcessingMode.Cloud)}
                </HStack>
            </Box>

            {/* Model Management Section — only relevant when the user wants
                on-device AND the device can actually run it. Otherwise this
                whole concept is implementation detail the user shouldn't see. */}
            {onDeviceIntent && deviceSupported === true && (
                <>
                    <Box className="mx-5 mb-6 border-b border-gray-800" />

                    <Box className="px-5 mb-6">
                        <HStack className="items-center justify-between mb-1">
                            <Text className="text-white text-lg font-semibold">{t('meraProtocol.aiModel')}</Text>
                            {(modelState === 'downloaded' || modelState === 'ready') && (
                                <Pressable
                                    onPress={handleDeleteModel}
                                    className="bg-red-950 rounded-full p-2"
                                >
                                    <MaterialIcons name="delete-outline" size={20} color="#ef4444" />
                                </Pressable>
                            )}
                        </HStack>
                        <Text size="xs" className="text-typography-500 mb-3">
                            {t('meraProtocol.modelRequiredForOnDevice')}
                        </Text>

                        {/* Model picker: one model on disk at a time. */}
                        <Text size="xs" className="text-typography-400 mb-2">
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
                                            accessibilityLabel={`${entry.label}, ${entry.sizeLabel}`}
                                            accessibilityState={{ selected, disabled: locked }}
                                            className={
                                                'rounded-lg px-4 py-3 border ' +
                                                (selected
                                                    ? 'border-emerald-500 bg-emerald-950'
                                                    : 'border-gray-700 bg-background-50') +
                                                (locked && !selected ? ' opacity-50' : '')
                                            }
                                        >
                                            <HStack space="md" className="items-center">
                                                <MaterialIcons
                                                    name={selected ? 'radio-button-checked' : 'radio-button-unchecked'}
                                                    size={20}
                                                    color={selected ? '#34d399' : '#9ca3af'}
                                                />
                                                <Text className={'flex-1 font-medium ' + (selected ? 'text-emerald-400' : 'text-white')}>
                                                    {entry.label}
                                                </Text>
                                                <Text size="xs" className="text-typography-400">
                                                    {entry.sizeLabel}
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
                                            <Text size="xs" className="text-typography-500 underline">
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
                            <Text className="text-typography-400 text-sm">{getModelStatusText()}</Text>
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
                                    <MaterialIcons name="cloud-download" size={18} color="#ffffff" style={{ marginRight: 8 }} />
                                    <ButtonText>
                                        {t('meraProtocol.downloadModelNamed', { model: currentModel.label, size: currentModel.sizeLabel })}
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
                                    <MaterialIcons name="close" size={18} color="#ef4444" style={{ marginRight: 8 }} />
                                    <ButtonText className="text-red-400">{t('meraProtocol.cancelDownload')}</ButtonText>
                                </Button>
                            )}

                            {modelState === 'error' && (
                                <Button
                                    action="primary"
                                    variant="solid"
                                    size="md"
                                    onPress={handleDownloadModel}
                                >
                                    <MaterialIcons name="refresh" size={18} color="#ffffff" style={{ marginRight: 8 }} />
                                    <ButtonText>{t('meraProtocol.retryDownload')}</ButtonText>
                                </Button>
                            )}
                        </VStack>

                        {/* Speed on this device: in memory only, never stored or sent. */}
                        {inferenceStats.modelId === selectedModelId && (
                            <VStack space="xs" className="mt-4" testID="mera-protocol-speed">
                                <Text className="text-white text-sm font-semibold">
                                    {t('meraProtocol.speedTitle')}
                                </Text>
                                {inferenceStats.loadMs != null && (
                                    <Text size="xs" className="text-typography-400">
                                        {t('meraProtocol.speedLoad', { seconds: (inferenceStats.loadMs / 1000).toFixed(1) })}
                                    </Text>
                                )}
                                {inferenceStats.genTokPerSec != null && (
                                    <Text size="xs" className="text-typography-400">
                                        {t('meraProtocol.speedGeneration', { tokPerSec: inferenceStats.genTokPerSec })}
                                    </Text>
                                )}
                                {averageMs(inferenceStats.relevance) != null && (
                                    <Text size="xs" className="text-typography-400">
                                        {t('meraProtocol.speedRelevance', { ms: averageMs(inferenceStats.relevance) })}
                                    </Text>
                                )}
                                {averageMs(inferenceStats.reason) != null && (
                                    <Text size="xs" className="text-typography-400">
                                        {t('meraProtocol.speedReason', { ms: averageMs(inferenceStats.reason) })}
                                    </Text>
                                )}
                                <Text size="xs" className="text-typography-500">
                                    {t('meraProtocol.speedResetNote')}
                                </Text>
                            </VStack>
                        )}
                    </Box>
                </>
            )}

            {/* Relevance scoring v4 toggle — one switch, two measured features
                on the classic path (tag metadata in the scoring prompt + the
                low-value-event reason gate). This is the same persisted setting
                the retired v3 beta used; see SETTING_RELEVANCE_V4. */}
            <Box className="px-5 mb-6" testID="mera-protocol-relevance-v4">
                <HStack space="md" className="items-center justify-between">
                    <HStack space="md" className="items-center flex-1">
                        <MaterialIcons
                            name="tune"
                            size={24}
                            color={relevanceV4 ? "#10b981" : "#9ca3af"}
                        />
                        <VStack className="flex-1">
                            <Text className="text-white text-base font-semibold">
                                {t('meraProtocol.relevanceV4Title')}
                            </Text>
                            <Text className="text-typography-500 text-sm mt-0.5">
                                {relevanceV4
                                    ? t('meraProtocol.relevanceV4On')
                                    : t('meraProtocol.relevanceV4Off')}
                            </Text>
                        </VStack>
                    </HStack>
                    <Switch
                        value={relevanceV4}
                        onToggle={() => store.setRelevanceV4(!relevanceV4)}
                        size="md"
                        testID="mera-protocol-relevance-v4-switch"
                    />
                </HStack>
                <Text className="text-typography-500 text-xs mt-2">
                    {t('meraProtocol.relevanceV4Description')}
                </Text>
            </Box>

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
            <Box className="px-5 mb-6" testID="mera-protocol-web-search">
                <HStack space="md" className="items-center justify-between">
                    <HStack space="md" className="items-center flex-1">
                        <MaterialIcons
                            name="travel-explore"
                            size={24}
                            color={webSearchInChat ? "#10b981" : "#9ca3af"}
                        />
                        <VStack className="flex-1">
                            <HStack space="xs" className="items-center">
                                <Text className="text-white text-base font-semibold">
                                    {t('meraProtocol.webSearchTitle')}
                                </Text>
                                <BetaBadge />
                            </HStack>
                            <Text className="text-typography-500 text-sm mt-0.5">
                                {webSearchInChat
                                    ? t('meraProtocol.webSearchOn')
                                    : t('meraProtocol.webSearchOff')}
                            </Text>
                        </VStack>
                    </HStack>
                    <Switch
                        value={webSearchInChat}
                        onToggle={() => store.setWebSearchInChat(!webSearchInChat)}
                        size="md"
                        testID="mera-protocol-web-search-switch"
                    />
                </HStack>
                <Text className="text-typography-500 text-xs mt-2">
                    {t('meraProtocol.webSearchDescription')}
                </Text>
            </Box>

            {/* Auto community fact check — OFF by default, and NESTED under the
                switch above: it is meaningless with fact checking off, so it is
                hidden rather than left tappable and inert.

                A check is cached against the ARTICLE, so one reader's request
                answers for everyone. This decides whether Mera LOOKS for that
                answer on every article opened, or only when the reader taps the
                button. Off, the lookup is a deliberate act on one article,
                which is exactly how the privacy policy describes it. */}
            <Box className="px-5 mb-6" testID="mera-protocol-auto-community-fact-check">
                    <HStack space="md" className="items-center justify-between">
                        <HStack space="md" className="items-center flex-1">
                            <MaterialIcons
                                name="groups"
                                size={24}
                                color={autoCommunityFactCheck ? "#10b981" : "#9ca3af"}
                            />
                            <VStack className="flex-1">
                                <Text className="text-white text-base font-semibold">
                                    {t('meraProtocol.autoCommunityFactCheckTitle')}
                                </Text>
                                <Text className="text-typography-500 text-sm mt-0.5">
                                    {autoCommunityFactCheck
                                        ? t('meraProtocol.autoCommunityFactCheckOn')
                                        : t('meraProtocol.autoCommunityFactCheckOff')}
                                </Text>
                            </VStack>
                        </HStack>
                        <Switch
                            value={autoCommunityFactCheck}
                            onToggle={() =>
                                store.setAutoCommunityFactCheck(!autoCommunityFactCheck)
                            }
                            size="md"
                            testID="mera-protocol-auto-community-fact-check-switch"
                        />
                    </HStack>
                <Text className="text-typography-500 text-xs mt-2">
                    {t('meraProtocol.autoCommunityFactCheckDescription')}
                </Text>
            </Box>

            {/* Deeper questions (item 17) — OFF by default. The copy's job is to
                say why Mera can ask questions this personal at all: the answers
                are facts, and facts never leave the device. */}
            <Box className="px-5 mb-6" testID="mera-protocol-deep-interview">
                <HStack space="md" className="items-center justify-between">
                    <HStack space="md" className="items-center flex-1">
                        <MaterialIcons
                            name="psychology"
                            size={24}
                            color={deepInterview ? "#10b981" : "#9ca3af"}
                        />
                        <VStack className="flex-1">
                            <Text className="text-white text-base font-semibold">
                                {t('meraProtocol.deepInterviewTitle')}
                            </Text>
                            <Text className="text-typography-500 text-sm mt-0.5">
                                {deepInterview
                                    ? t('meraProtocol.deepInterviewOn')
                                    : t('meraProtocol.deepInterviewOff')}
                            </Text>
                        </VStack>
                    </HStack>
                    <Switch
                        value={deepInterview}
                        onToggle={() => store.setDeepInterview(!deepInterview)}
                        size="md"
                        testID="mera-protocol-deep-interview-switch"
                    />
                </HStack>
                <Text className="text-typography-500 text-xs mt-2">
                    {t('meraProtocol.deepInterviewDescription')}
                </Text>
            </Box>

            {/* Show extracted metadata — OFF by default. This metadata is
                machine-extracted and measurably imperfect, so the toggle's own
                description says plainly what it shows and that it is an AI
                read of the story, not a verified fact — the detail-screen
                panel repeats that provenance caption next to the data itself. */}
            <Box className="px-5 mb-6" testID="mera-protocol-extracted-metadata">
                <HStack space="md" className="items-center justify-between">
                    <HStack space="md" className="items-center flex-1">
                        <MaterialIcons
                            name="label-outline"
                            size={24}
                            color={showExtractedMetadata ? "#10b981" : "#9ca3af"}
                        />
                        <VStack className="flex-1">
                            <Text className="text-white text-base font-semibold">
                                {t('meraProtocol.extractedMetadataTitle')}
                            </Text>
                            <Text className="text-typography-500 text-sm mt-0.5">
                                {showExtractedMetadata
                                    ? t('meraProtocol.extractedMetadataOn')
                                    : t('meraProtocol.extractedMetadataOff')}
                            </Text>
                        </VStack>
                    </HStack>
                    <Switch
                        value={showExtractedMetadata}
                        onToggle={() => store.setShowExtractedMetadata(!showExtractedMetadata)}
                        size="md"
                        testID="mera-protocol-extracted-metadata-switch"
                    />
                </HStack>
                <Text className="text-typography-500 text-xs mt-2">
                    {t('meraProtocol.extractedMetadataDescription')}
                </Text>
            </Box>

            {/* Privacy Explainer */}
            <Box className="px-5 mb-6">
                <Box className="p-4 rounded-lg border border-primary-400">
                    <HStack space="md" className="items-start">
                        <VStack className="flex-1">
                            <Text className="text-typography-400 text-base font-semibold mb-1">
                                {t('meraProtocol.privacyTitle')}
                            </Text>
                            <Text className="text-typography-400 text-sm">
                                {t('meraProtocol.privacyDescription')}
                            </Text>
                        </VStack>
                    </HStack>
                </Box>
            </Box>

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
                    <Box className="p-4 rounded-lg border bg-red-950 border-red-800">
                        <Pressable onPress={() => setShowRequirements(prev => !prev)}>
                            <HStack space="md" className="items-start">
                                <MaterialIcons
                                    name="warning"
                                    size={24}
                                    color="#ef4444"
                                    style={{ marginTop: 2 }}
                                />
                                <VStack className="flex-1">
                                    <Text className="text-base font-semibold mb-1 text-red-400">
                                        {t('meraProtocol.deviceNotSupported')}
                                    </Text>
                                    <Text className="text-sm text-red-300">
                                        {t('meraProtocol.deviceNotSupportedDescription')}
                                    </Text>
                                </VStack>
                                <MaterialIcons
                                    name={showRequirements ? 'keyboard-arrow-up' : 'keyboard-arrow-down'}
                                    size={24}
                                    color="#ef4444"
                                    style={{ marginTop: 2 }}
                                />
                            </HStack>
                        </Pressable>

                        {/* System Requirements (accordion) */}
                        {showRequirements && (
                            <VStack space="sm" className="mt-4 pt-4 border-t" style={{ borderTopColor: '#7f1d1d' }}>
                                <HStack space="sm" className="items-center">
                                    <MaterialIcons
                                        name={requirementsResult.failedCheck === 'ram' ? 'cancel' : 'check-circle'}
                                        size={16}
                                        color={requirementsResult.failedCheck === 'ram' ? '#ef4444' : '#10b981'}
                                    />
                                    <Text className="text-typography-400 text-sm">
                                        {t('meraProtocol.ramLabel')}{requirementsResult.deviceInfo.ramGB != null ? ` (yours: ${requirementsResult.deviceInfo.ramGB}GB)` : ''}
                                    </Text>
                                </HStack>
                                <HStack space="sm" className="items-center">
                                    <MaterialIcons
                                        name={requirementsResult.failedCheck === 'os_version' ? 'cancel' : 'check-circle'}
                                        size={16}
                                        color={requirementsResult.failedCheck === 'os_version' ? '#ef4444' : '#10b981'}
                                    />
                                    <Text className="text-typography-400 text-sm">
                                        {Platform.OS === 'ios' ? t('meraProtocol.iosVersion') : t('meraProtocol.androidVersion')}{requirementsResult.deviceInfo.osVersion ? ` (yours: ${requirementsResult.deviceInfo.osVersion})` : ''}
                                    </Text>
                                </HStack>
                                {Platform.OS === 'ios' && (
                                    <HStack space="sm" className="items-center">
                                        <MaterialIcons
                                            name={requirementsResult.failedCheck === 'chip' ? 'cancel' : 'check-circle'}
                                            size={16}
                                            color={requirementsResult.failedCheck === 'chip' ? '#ef4444' : '#10b981'}
                                        />
                                        <Text className="text-typography-400 text-sm">{t('meraProtocol.chipLabel')}</Text>
                                    </HStack>
                                )}
                                <HStack space="sm" className="items-center">
                                    <MaterialIcons
                                        name={requirementsResult.failedCheck === 'storage' ? 'cancel' : 'check-circle'}
                                        size={16}
                                        color={requirementsResult.failedCheck === 'storage' ? '#ef4444' : '#10b981'}
                                    />
                                    <Text className="text-typography-400 text-sm">
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
                    <ModalHeader className="border-gray-700 pb-4">
                        <Text className="text-xl font-semibold text-red-400">{t('meraProtocol.deleteTitle')}</Text>
                    </ModalHeader>
                    <ModalBody className="py-6">
                        <Text className="text-gray-300 text-base leading-relaxed">
                            {t('meraProtocol.deleteModelDescription', { model: currentModel.label, size: currentModel.sizeLabel })}
                        </Text>
                    </ModalBody>
                    <ModalFooter className="border-t border-gray-700 pt-4">
                        <VStack className="w-full" space="md">
                            <Button
                                action="negative"
                                onPress={confirmDeleteModel}
                                disabled={isDeletingModel}
                                className="w-full"
                            >
                                <ButtonText>
                                    {isDeletingModel ? 'Deleting...' : t('meraProtocol.deleteButton')}
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
                    <ModalHeader className="border-gray-700 pb-4">
                        <Text className="text-xl font-semibold text-white">{t('meraProtocol.switchModelTitle')}</Text>
                    </ModalHeader>
                    <ModalBody className="py-6">
                        <Text className="text-gray-300 text-base leading-relaxed">
                            {t('meraProtocol.switchModelDescription', {
                                current: currentModel.label,
                                new: pendingSwitchTo?.label ?? '',
                            })}
                        </Text>
                    </ModalBody>
                    <ModalFooter className="border-t border-gray-700 pt-4">
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
        if (isOnboarding) {
            return (
                <VStack className="flex-1 justify-center items-center">
                    <Spinner size="large" />
                </VStack>
            );
        }
        return (
            <GluestackUIProvider mode="dark">
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

    // Onboarding mode — nav buttons are rendered by OnboardingNavBar
    if (isOnboarding) {
        return (
            <Box className="flex-1">
                <ScrollView className="flex-1">
                    {renderContent()}
                </ScrollView>
            </Box>
        );
    }

    // Preferences mode
    // Keep `isOnDevice` referenced so eslint doesn't strip the selector.
    void isOnDevice;

    return (
        <GluestackUIProvider mode="dark">
            <Box className="flex-1">
                {/* Page background. Must be the FIRST child so it paints behind
                    everything else on the page. */}
                <AbstractGradientBackdrop />

                <Box style={{ paddingTop: insets.top }}>
                    <DrillDownHeader title={t('meraProtocol.title')} onBack={onBack} />
                </Box>

                <ScrollView className="flex-1 pt-1" contentContainerStyle={{ paddingBottom: 24 }}>
                    {renderContent()}
                </ScrollView>

            </Box>
        </GluestackUIProvider>
    );
};

export default MeraProtocolSettingsScreen;
