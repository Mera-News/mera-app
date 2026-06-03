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
import type { SystemRequirementsResult } from '@/lib/mera-protocol-toolkit/types';
import {
    useDownloadProgress,
    useInjectNoise,
    useMeraProtocolStore,
    useModelState as useModelStateSelector,
    useProcessingMode,
    useSelectedModelId,
} from '@/lib/stores/mera-protocol-store';
import { getSetting, setSetting } from '@/lib/database/services/setting-service';
import { Switch } from '@/components/ui/switch';
import { MaterialIcons } from '@expo/vector-icons';
import React, { useCallback, useEffect, useState } from 'react';
import { Platform, ScrollView } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTranslation } from 'react-i18next';

type ModelConfig = {
    modelId: string;
    label: string;
    modelUrl: string;
    expectedChecksum: string;
    sizeLabel: string;
};

// The latest model — new installs get this automatically.
// When this changes, users on an older model will see an "Update Model" button.
const LATEST_MODEL: ModelConfig = {
    modelId: 'mera-qwen3.5-4b',
    label: 'Qwen 3.5 4B',
    modelUrl: 'https://huggingface.co/unsloth/Qwen3.5-4B-GGUF/resolve/main/Qwen3.5-4B-Q4_K_M.gguf',
    expectedChecksum: '',
    sizeLabel: '~2.8GB',
};

// Previous models — only used to display the label for users who haven't updated yet.
const KNOWN_MODELS: Record<string, ModelConfig> = {
    'mera-qwen3.5-4b': LATEST_MODEL,
    'mera-qwen3-4b': {
        modelId: 'mera-qwen3-4b',
        label: 'Qwen 3 4B',
        modelUrl: 'https://huggingface.co/MaziyarPanahi/Qwen3-4B-Instruct-2507-GGUF/resolve/main/Qwen3-4B-Instruct-2507.Q4_K_M.gguf',
        expectedChecksum: '',
        sizeLabel: '~2GB',
    },
};

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
    const [isUpdatingModel, setIsUpdatingModel] = useState(false);
    const [showUpdateModelConfirm, setShowUpdateModelConfirm] = useState(false);

    const processingMode = useProcessingMode();
    const isOnDevice = processingMode === ProcessingMode.OnDevice;
    const selectedModelId = useSelectedModelId();
    const modelState = useModelStateSelector();
    const downloadProgress = useDownloadProgress();
    const injectNoise = useInjectNoise();
    const store = useMeraProtocolStore();
    const [useFlowV2, setUseFlowV2] = useState(false);

    const currentModel = KNOWN_MODELS[selectedModelId] ?? LATEST_MODEL;
    const hasModelUpdate = selectedModelId !== LATEST_MODEL.modelId;
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

    const handleFlowV2Toggle = async (enabled: boolean) => {
        setUseFlowV2(enabled);
        await setSetting('use_flow_v2', enabled ? 'true' : 'false');
    };

    const loadSettings = async () => {
        try {
            const [userId, flowV2Raw] = await Promise.all([
                getCurrentUserId(),
                getSetting('use_flow_v2'),
            ]);
            setUseFlowV2(flowV2Raw === 'true');
            const userPersona = await AccountService.getUserPersona(userId);
            if (userPersona?.processingMode) {
                store.setProcessingMode(userPersona.processingMode);
                setOnDeviceIntent(userPersona.processingMode === ProcessingMode.OnDevice);
            }
            await checkModelStatus();
        } catch {
            toast.show({
                placement: 'top',
                render: () => (
                    <Toast action="error" variant="solid">
                        <ToastTitle>Load Failed</ToastTitle>
                        <ToastDescription>Failed to load Mera Protocol settings.</ToastDescription>
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

    const handleUpdateModel = useCallback(async () => {
        setIsUpdatingModel(true);
        setShowUpdateModelConfirm(false);
        try {
            if (modelState === 'ready' || modelState === 'downloaded') {
                await disposeModel();
                await deleteBaseModel(selectedModelId);
            }

            store.setSelectedModelId(LATEST_MODEL.modelId);
            store.setModelState('not_downloaded');
            store.setDownloadProgress(0);

            toast.show({
                placement: 'top',
                render: () => (
                    <Toast action="success" variant="solid">
                        <ToastTitle>{t('meraProtocol.modelUpdatedTitle')}</ToastTitle>
                        <ToastDescription>{t('meraProtocol.modelUpdatedDescription', { model: LATEST_MODEL.label })}</ToastDescription>
                    </Toast>
                ),
            });
        } catch {
            toast.show({
                placement: 'top',
                render: () => (
                    <Toast action="error" variant="solid">
                        <ToastTitle>{t('meraProtocol.modelUpdateFailedTitle')}</ToastTitle>
                        <ToastDescription>{t('meraProtocol.modelUpdateFailedDescription')}</ToastDescription>
                    </Toast>
                ),
            });
        } finally {
            setIsUpdatingModel(false);
        }
    }, [selectedModelId, modelState, store, toast, t]);

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
        const selected = onDevicePill ? onDeviceIntent : !onDeviceIntent;

        const iconName = onDevicePill ? 'smartphone' : 'cloud';
        const titleKey = onDevicePill ? 'meraProtocol.onDeviceMode' : 'meraProtocol.cloudMode';
        const subtitleKey = onDevicePill
            ? 'meraProtocol.onDeviceModeSubtitle'
            : 'meraProtocol.cloudModeSubtitle';

        const baseClass = 'flex-1 rounded-lg px-4 py-3 border ';
        const stateClass = selected
            ? 'border-emerald-500 bg-emerald-950'
            : 'border-gray-700 bg-background-900';

        const iconColor = selected ? '#34d399' : '#9ca3af';
        const titleClass = selected ? 'text-emerald-400' : 'text-white';

        return (
            <Pressable
                key={mode}
                onPress={() => selectMode(mode)}
                disabled={isUpdatingMode}
                className={baseClass + stateClass}
            >
                <VStack space="xs" className="items-center">
                    <MaterialIcons name={iconName} size={22} color={iconColor} />
                    <Text className={'text-center font-medium ' + titleClass}>
                        {t(titleKey)}
                    </Text>
                    <Text size="xs" className="text-center text-typography-400">
                        {t(subtitleKey)}
                    </Text>
                </VStack>
            </Pressable>
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
                                    <ButtonText>{t('meraProtocol.downloadModel')}</ButtonText>
                                </Button>
                            )}

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

                            {/* Update Model — only shown when a newer model is available */}
                            {hasModelUpdate && modelState !== 'downloading' && (
                                <Button
                                    action="primary"
                                    variant="outline"
                                    size="md"
                                    onPress={() => setShowUpdateModelConfirm(true)}
                                    isDisabled={isUpdatingModel}
                                >
                                    <MaterialIcons name="system-update" size={18} color="#a78bfa" style={{ marginRight: 8 }} />
                                    <ButtonText className="text-purple-400">
                                        {isUpdatingModel ? t('common.updating') : t('meraProtocol.updateTo', { modelName: LATEST_MODEL.label })}
                                    </ButtonText>
                                </Button>
                            )}
                        </VStack>
                    </Box>
                </>
            )}

            {/* DEPRECATED: Noise Injection — see deprecate-article-suggestion-flow.md
            <Box className="mx-5 mb-6 border-b border-gray-800" />

            <Box className="px-5 mb-6">
                <HStack className="items-center justify-between mb-1">
                    <Text className="text-white text-lg font-semibold">
                        {t('meraProtocol.injectNoiseTitle')}
                    </Text>
                    <Switch
                        value={injectNoise}
                        onValueChange={(v: boolean) => store.setInjectNoise(v)}
                        trackColor={{ false: '#374151', true: '#10b981' }}
                        thumbColor="#ffffff"
                    />
                </HStack>
                <Text className="text-typography-400 text-sm leading-5 mb-2">
                    {t('meraProtocol.injectNoiseDescription')}
                </Text>
                <Text className="text-amber-400 text-xs leading-4">
                    {t('meraProtocol.injectNoiseBeta')}
                </Text>
            </Box>
            END DEPRECATED */}

            {/* Flow v2 (Beta) — stateless API toggle */}
            <Box className="mx-5 mb-6 border-b border-gray-800" />

            <Box className="px-5 mb-6">
                <HStack className="items-center justify-between mb-1">
                    <Text className="text-white text-lg font-semibold">
                        Use Flow v2 (Beta)
                    </Text>
                    <Switch
                        value={useFlowV2}
                        onValueChange={handleFlowV2Toggle}
                        trackColor={{ false: '#374151', true: '#10b981' }}
                        thumbColor="#ffffff"
                    />
                </HStack>
                <Text className="text-typography-400 text-sm leading-5 mb-2">
                    Send your topic texts directly to fetch matching articles. The server caches results for 30 minutes.
                </Text>
                <Text className="text-amber-400 text-xs leading-4">
                    Beta — off by default. Takes effect on next feed refresh.
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
                            <Text className="text-typography-400 text-sm leading-5">
                                {t('meraProtocol.privacyDescription')}
                            </Text>
                        </VStack>
                    </HStack>
                </Box>
            </Box>

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
                                    <Text className="text-sm leading-5 text-red-300">
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
                            {t('meraProtocol.deleteDescription')}
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

            {/* Update AI Model Confirmation Modal */}
            <Modal isOpen={showUpdateModelConfirm} onClose={() => setShowUpdateModelConfirm(false)} size="sm">
                <ModalBackdrop />
                <ModalContent>
                    <ModalHeader className="border-gray-700 pb-4">
                        <Text className="text-xl font-semibold text-purple-400">{t('meraProtocol.updateTitle')}</Text>
                    </ModalHeader>
                    <ModalBody className="py-6">
                        <Text className="text-gray-300 text-base leading-relaxed">
                            {t('meraProtocol.updateDescription', { current: currentModel.label, new: LATEST_MODEL.label })}
                        </Text>
                    </ModalBody>
                    <ModalFooter className="border-t border-gray-700 pt-4">
                        <VStack className="w-full" space="md">
                            <Button
                                action="primary"
                                onPress={handleUpdateModel}
                                isDisabled={isUpdatingModel}
                                className="w-full"
                            >
                                <ButtonText>
                                    {isUpdatingModel ? t('common.updating') : t('meraProtocol.updateButton')}
                                </ButtonText>
                            </Button>
                            <Button
                                variant="outline"
                                action="secondary"
                                onPress={() => setShowUpdateModelConfirm(false)}
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
                <Box className="flex-1 bg-black">
                    {onBack && (
                        <Box style={{ position: 'absolute', top: insets.top + 16, left: 16, zIndex: 20 }}>
                            <Pressable
                                onPress={onBack}
                                className="bg-gray-900 rounded-full p-3 shadow-hard-2"
                            >
                                <MaterialIcons name="arrow-back" size={24} color="#ffffff" />
                            </Pressable>
                        </Box>
                    )}
                    <VStack className="px-5 pb-5" style={{ paddingTop: insets.top + 16 }}>
                        <Text className="text-xl font-semibold text-white text-center">{t('meraProtocol.title')}</Text>
                    </VStack>
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
            <Box className="flex-1 bg-black">
                {onBack && (
                    <Box style={{ position: 'absolute', top: insets.top + 16, left: 16, zIndex: 20 }}>
                        <Pressable
                            onPress={onBack}
                            className="bg-gray-900 rounded-full p-3 shadow-hard-2"
                        >
                            <MaterialIcons name="arrow-back" size={24} color="#ffffff" />
                        </Pressable>
                    </Box>
                )}

                <VStack className="px-5 pb-5" style={{ paddingTop: insets.top + 16 }}>
                    <Text className="text-xl font-semibold text-white text-center">{t('meraProtocol.title')}</Text>
                </VStack>

                <ScrollView className="flex-1 pt-1">
                    {renderContent()}
                </ScrollView>
            </Box>
        </GluestackUIProvider>
    );
};

export default MeraProtocolSettingsScreen;
