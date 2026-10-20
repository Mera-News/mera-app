import { Toast, ToastDescription, ToastTitle, useToast } from '@/components/ui/toast';
import { AccountService } from '@/lib/account-service';
import { showDialog } from '@/lib/dialog';
import { ProcessingMode } from '@/lib/generated/graphql-types';
import {
    BUILT_IN_MODEL_NAME,
    cancelModelDownload,
    onDeviceModelsStatus,
    promoteToOnDevice,
    setPromoteWhenDone,
    startModelDownloads,
    useModelDownloads,
    willPromoteWhenDone,
    type ModelDownload,
} from '@/lib/mera-protocol-toolkit/core/downloadService';
import { deleteDownloadedModel } from '@/lib/mera-protocol-toolkit/core/modelManager';
import { RELEVANCE_MODEL, TEXT_MODEL, type ModelCatalogEntry } from '@/lib/mera-protocol-toolkit/core/model-catalog';
import {
    builtInAvailability,
    builtInEngine,
    setTextEngine,
    useTextEngine,
    getTextEngine,
    isBuiltInEngine,
    type BuiltInEngine,
    type TextEngine,
} from '@/lib/mera-protocol-toolkit/core/text-engine';
import type { OnDeviceLlmAvailability } from '@/modules/mera-on-device-llm';
import {
    checkRequirements,
    STORAGE_MARGIN_BYTES,
} from '@/lib/mera-protocol-toolkit/core/systemRequirements';
import {
    resetInferenceStats,
    useInferenceStats,
} from '@/lib/mera-protocol-toolkit/core/inference-stats';
import type { SystemRequirementsResult } from '@/lib/mera-protocol-toolkit/types';
import { rependOnDeviceNotes } from '@/lib/mera-protocol/scoring-service';
import {
    useMeraProtocolStore,
    useOnDeviceNotes,
    useProcessingMode,
    useWebSearchInChat,
} from '@/lib/stores/mera-protocol-store';
import { useUserStore } from '@/lib/stores/user-store';
import { resolveCurrentUserId } from '@/lib/security/current-user';
import logger from '@/lib/logger';
import NetInfo from '@react-native-community/netinfo';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { AppState } from 'react-native';
import { useTranslation } from 'react-i18next';
import {
    loadBgRefreshToggle,
    saveBgRefreshToggle,
} from '@/lib/background/bg-refresh-ui';

/** Decimal gigabytes with one place, the way the catalogue sizes read. */
export const gbText = (bytes: number): string => (bytes / 1e9).toFixed(1);

/**
 * Why the built-in model (Apple Intelligence, Gemini Nano) cannot be picked, by
 * availability code. Every line takes the model's name as `{{name}}`.
 * `unsupportedPlatform` has no line: the row is not shown there.
 */
export const NATIVE_REASON_KEYS = {
    deviceNotEligible: 'meraProtocol.nativeDeviceNotEligible',
    appleIntelligenceNotEnabled: 'meraProtocol.nativeNotEnabled',
    modelNotReady: 'meraProtocol.nativeNotReady',
    appLanguageNotSupported: 'meraProtocol.nativeAppLanguage',
    deviceLanguageNotSupported: 'meraProtocol.nativeDeviceLanguage',
    osTooOld: 'meraProtocol.nativeOsTooOld',
    needsSystemUpdate: 'meraProtocol.nativeNeedsUpdate',
    unknown: 'meraProtocol.nativeUnknown',
} as const;

/**
 * Every key the model sections can show, for the no-names test: Apple
 * Intelligence and Gemini Nano may be named, the downloaded models never are.
 */
export const MODELS_SECTION_KEYS = [
    'meraProtocol.relevanceTitle',
    'meraProtocol.relevanceHelp',
    'meraProtocol.textTitle',
    'meraProtocol.textHelp',
    'meraProtocol.textMera',
    'meraProtocol.notesTitle',
    'meraProtocol.notesHelp',
    'meraProtocol.modelsHelp',
    'meraProtocol.modelsWaitingNative',
    'meraProtocol.modelReady',
    'meraProtocol.modelQueued',
    'meraProtocol.modelRowReady',
    'meraProtocol.modelRowMissing',
    'meraProtocol.modelLicenseLink',
    'meraProtocol.downloadAction',
    'meraProtocol.downloadingOf',
    'meraProtocol.cancelDownloadAction',
    'meraProtocol.tryAgain',
    'meraProtocol.deleteModelLabel',
    'meraProtocol.deleteModelTitle',
    'meraProtocol.deleteRelevanceBody',
    'meraProtocol.deleteTextBody',
    'meraProtocol.deleteFailedDescription',
    'meraProtocol.textModelGoneTitle',
    'meraProtocol.textModelGoneBody',
    'meraProtocol.cellularTitle',
    'meraProtocol.cellularBody',
    'meraProtocol.cellularConfirm',
    'meraProtocol.cellularWait',
    'meraProtocol.freeUpToDownload',
    'meraProtocol.errorFinish',
    'meraProtocol.errorFile',
    'meraProtocol.errorSpace',
    'meraProtocol.speedTitle',
    'meraProtocol.speedLoad',
    'meraProtocol.speedGeneration',
    'meraProtocol.speedRanking',
    'meraProtocol.speedNotes',
    'meraProtocol.speedRefused',
    'meraProtocol.speedResetNote',
    'download.onDeviceReady',
    'download.relevanceDone',
    'download.textDone',
    'download.modelDownloading',
    ...Object.values(NATIVE_REASON_KEYS),
] as const;

/** Keeps the cached server persona in step with a mode the server just accepted (the boot purge reads it). */
function cacheProcessingMode(mode: ProcessingMode): void {
    const persona = useUserStore.getState().userPersona;
    if (persona) useUserStore.getState().setUserPersona({ ...persona, processingMode: mode });
}

type ModelsStatus = Awaited<ReturnType<typeof onDeviceModelsStatus>>;

/** One downloadable model's row: Mera relevance model, or Mera text model. Every on-device row is Beta (D30). */
export type ModelRowState = {
    modelId: string;
    titleKey: 'meraProtocol.relevanceTitle' | 'meraProtocol.textMera';
    sizeBytes: number;
    onDisk: boolean;
    /** Queued, downloading or failed; null when nothing is happening to it. */
    download: ModelDownload | null;
    /** Not on disk and too little free space to download it. */
    storageShort: boolean;
    /** What to free to download it, e.g. "1.3 GB". */
    freeUpSize: string;
    beta: true;
};

/** One Text model radio: the Mera text model (a download), or this phone's built-in model. */
export type TextOption = {
    engine: TextEngine;
    /** "Mera text model", "Apple Intelligence" or "Gemini Nano". */
    title: string;
    selected: boolean;
    disabled: boolean;
    /** Why a built-in model cannot be picked (already translated); null when it can. */
    reason: string | null;
    /** The download row, for the Mera text model only. */
    model: ModelRowState | null;
    beta: true;
};

export function useMeraProtocolSettings() {
    const { t } = useTranslation();
    const [isLoading, setIsLoading] = useState(true);
    const [isUpdatingMode, setIsUpdatingMode] = useState(false);
    const [requirementsResult, setRequirementsResult] = useState<SystemRequirementsResult | null>(null);
    const [showRequirements, setShowRequirements] = useState(false);
    const [isDeletingModel, setIsDeletingModel] = useState(false);
    // Each model on disk or not, and whether On this phone can run.
    const [status, setStatus] = useState<ModelsStatus | null>(null);
    // The built-in model's availability, re-read on every focus (it can change while the app runs).
    const [native, setNative] = useState<OnDeviceLlmAvailability | null>(null);
    const textEngine = useTextEngine();
    // This platform's built-in model, if the native module is there: 'afm' on iOS, 'nano' on Android.
    const builtIn = builtInEngine();

    const processingMode = useProcessingMode();
    const isOnDevice = processingMode === ProcessingMode.OnDevice;
    const store = useMeraProtocolStore();
    const webSearchInChat = useWebSearchInChat();
    const onDeviceNotes = useOnDeviceNotes();
    const inferenceStats = useInferenceStats();
    const downloads = useModelDownloads();

    const toast = useToast();

    const runnable = status?.runnable ?? false;
    const nativeAvailable = native?.available ?? false;
    const builtInName = builtIn ? BUILT_IN_MODEL_NAME[builtIn] : null;

    const deviceSupported = requirementsResult ? requirementsResult.supported : null;
    const onDeviceAvailable = deviceSupported !== false && runnable;
    const freeGb = requirementsResult?.deviceInfo.freeStorageGB ?? null;

    const modelRow = (m: ModelCatalogEntry, titleKey: ModelRowState['titleKey']): ModelRowState => {
        const onDisk = status?.models[m.modelId]?.onDisk ?? false;
        // GB to free: the file plus the margin, less what is free.
        const shortfall = freeGb == null ? 0 : Math.max(0, m.sizeBytes + STORAGE_MARGIN_BYTES - freeGb * 1e9);
        return {
            modelId: m.modelId,
            titleKey,
            sizeBytes: m.sizeBytes,
            onDisk,
            download: downloads[m.modelId] ?? null,
            storageShort: !onDisk && shortfall > 0,
            freeUpSize: `${(Math.max(1, Math.ceil(shortfall / 1e8)) / 10).toFixed(1)} GB`,
            beta: true,
        };
    };
    const relevanceModel = modelRow(RELEVANCE_MODEL, 'meraProtocol.relevanceTitle');
    const textModel = modelRow(TEXT_MODEL, 'meraProtocol.textMera');

    // Drives which sections are visible. The user can express intent to run
    // on-device even when the runtime preconditions (device + models) aren't
    // met yet. `processingMode` only flips to OnDevice once on-device is runnable.
    const [onDeviceIntent, setOnDeviceIntent] = useState(
        processingMode === ProcessingMode.OnDevice,
    );

    const intentRef = useRef(onDeviceIntent);
    useEffect(() => {
        intentRef.current = onDeviceIntent;
    }, [onDeviceIntent]);
    // Set for the whole delete: nothing may promote the phone while its files are being removed.
    const deletingRef = useRef(false);

    // The Text model radios. The Mera text model is picked only once its file is on disk (its row
    // downloads it first), so a pick never drops a running phone to Private cloud for 2.7 GB. The
    // built-in model is shown only on its platform, and never needs a download.
    const showBuiltIn = builtIn != null && native != null && native.reason !== 'unsupportedPlatform';
    const textOptions: TextOption[] = [
        {
            engine: 'qwen',
            title: t('meraProtocol.textMera'),
            selected: textEngine === 'qwen',
            disabled: isDeletingModel || !textModel.onDisk,
            reason: null,
            model: textModel,
            beta: true,
        },
        ...(showBuiltIn && builtIn && builtInName
            ? [
                  {
                      engine: builtIn,
                      title: builtInName,
                      selected: textEngine === builtIn,
                      disabled: isDeletingModel || !nativeAvailable,
                      reason:
                          !nativeAvailable && native?.reason && native.reason !== 'unsupportedPlatform'
                              ? t(NATIVE_REASON_KEYS[native.reason], { name: builtInName })
                              : null,
                      model: null,
                      beta: true as const,
                  },
              ]
            : []),
    ];

    // The built-in model is the choice, its file need is met and it cannot run yet: without a line
    // the section would show everything downloaded and no way forward.
    const waitingForNative =
        onDeviceIntent && status != null && isBuiltInEngine(textEngine) && !runnable && relevanceModel.onDisk;
    const waitingLine = waitingForNative
        ? t('meraProtocol.modelsWaitingNative', { name: BUILT_IN_MODEL_NAME[textEngine as BuiltInEngine] })
        : null;

    // Reads what is on disk and whether the built-in model can be used. Pure: changes no mode.
    const readStatus = useCallback(async () => {
        const [next, availability] = await Promise.all([
            onDeviceModelsStatus(),
            builtInAvailability().catch(
                (): OnDeviceLlmAvailability => ({ available: false, reason: 'unsupportedPlatform' }),
            ),
        ]);
        setStatus(next);
        setNative(availability);
        return next;
    }, []);

    // While the reader wants On this phone, the phone follows what can run: it moves to On this phone
    // when it can, else falls back to Private cloud on this phone only (the server persona and the
    // intent are kept). Not held off by a running download: a phone running on the built-in model
    // stays on it while the text model downloads, and a landing promotes by itself.
    const applyIntent = useCallback(async (next: ModelsStatus) => {
        if (!intentRef.current || deletingRef.current) return;
        const current = useMeraProtocolStore.getState().processingMode;
        if (next.runnable) {
            if (current !== ProcessingMode.OnDevice) await promoteToOnDevice();
        } else if (current === ProcessingMode.OnDevice) {
            useMeraProtocolStore.getState().setProcessingMode(ProcessingMode.Cloud);
        }
    }, []);

    // Fresh on screen focus, when the app returns to the foreground (the built-in model can be
    // switched on in the phone's Settings) and after an engine switch.
    const refresh = useCallback(async () => {
        const next = await readStatus();
        await applyIntent(next);
        return next;
    }, [readStatus, applyIntent]);

    useEffect(() => {
        const sub = AppState.addEventListener('change', (state) => {
            if (state === 'active') void refresh();
        });
        return () => sub.remove();
    }, [refresh]);

    useEffect(() => {
        void getTextEngine();
    }, []);

    // Whether this phone can run On this phone at all. Storage is judged per model row.
    useEffect(() => {
        let alive = true;
        void checkRequirements().then((r) => {
            if (alive) setRequirementsResult(r);
        });
        return () => {
            alive = false;
        };
    }, []);

    // A download that lands, fails or is cancelled changes what is on disk.
    const downloadKey = Object.entries(downloads)
        .map(([id, d]) => `${id}:${d.status}`)
        .join(',');
    const lastDownloadKey = useRef(downloadKey);
    useEffect(() => {
        if (lastDownloadKey.current === downloadKey) return;
        lastDownloadKey.current = downloadKey;
        void readStatus();
    }, [downloadKey, readStatus]);

    // Background refresh (the `mera-background` OS task). Default ON; read from
    // settings, not a store, because the OS task reads the same row.
    const [bgRefreshEnabled, setBgRefreshEnabled] = useState(true);
    useEffect(() => {
        let alive = true;
        void loadBgRefreshToggle().then((enabled) => {
            if (alive) setBgRefreshEnabled(enabled);
        });
        return () => {
            alive = false;
        };
    }, []);
    const toggleBgRefresh = useCallback(() => {
        const next = !bgRefreshEnabled;
        setBgRefreshEnabled(next);
        saveBgRefreshToggle(next).catch(() => {
            // The save failed, so the switch goes back to what is stored.
            setBgRefreshEnabled(!next);
        });
    }, [bgRefreshEnabled]);

    // Write notes (D35). Back on, rows finalised without a note are owed one again.
    const toggleNotes = useCallback(() => {
        const next = !onDeviceNotes;
        useMeraProtocolStore.getState().setOnDeviceNotes(next);
        if (next) {
            rependOnDeviceNotes().catch((err) =>
                logger.captureException(err, { tags: { component: 'MeraProtocolSettings', method: 'rependOnDeviceNotes' } }),
            );
        }
    }, [onDeviceNotes]);

    useEffect(() => {
        loadSettings();
        // Mount-time load; the loader is stable and excluded on purpose.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    // Never writes the runtime modelState: that belongs to the model lifecycle, and
    // overwriting a 'ready' stopped the inference queue.
    const loadSettings = async () => {
        try {
            const userId = await resolveCurrentUserId();
            const userPersona = await AccountService.getUserPersona(userId);
            const { runnable: canRun } = await readStatus();
            if (userPersona?.processingMode) {
                const wantsOnDevice = userPersona.processingMode === ProcessingMode.OnDevice;
                // A download started with the on-device intent is still that intent, even though the
                // server says Cloud until a landing promotes the phone.
                setOnDeviceIntent(wantsOnDevice || willPromoteWhenDone());
                // Never promote OnDevice before it can run (a retired model, or one the OS
                // evicted from Caches). Keep the intent so the download rows show; a landing
                // promotes once it can run.
                const ok = !wantsOnDevice || canRun;
                store.setProcessingMode(ok ? userPersona.processingMode : ProcessingMode.Cloud);
            }
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
        // The intent mirrors the server persona. Read it before it is overwritten below: the local mode
        // is already Private cloud in the split state (server on-device, files missing), so comparing
        // against it would never write the reader's choice to the server.
        const hadIntent = intentRef.current;

        // Always reflect intent locally: it drives the help line and the download rows.
        setOnDeviceIntent(wantsOnDevice);
        // A download in flight follows the reader's latest choice.
        setPromoteWhenDone(wantsOnDevice);

        // If on-device isn't runnable yet, the contextual UI we just revealed
        // is the feedback. Don't persist or toast.
        if (wantsOnDevice && !onDeviceAvailable) return;
        if (mode === processingMode && wantsOnDevice === hadIntent) return;

        setIsUpdatingMode(true);
        try {
            const userId = await resolveCurrentUserId();
            await AccountService.updateProcessingMode(userId, mode);
            store.setProcessingMode(mode);
            cacheProcessingMode(mode);

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
            // The server still holds what it held: the intent goes back with it.
            setOnDeviceIntent(hadIntent);
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

    // The text model for chat, notes and topics. refresh() applies the On this phone intent to it.
    const selectEngine = useCallback(
        async (engine: TextEngine) => {
            if (engine === textEngine) return;
            await setTextEngine(engine);
            // The figures are the previous engine's: start clean rather than mix them in.
            resetInferenceStats();
            await refresh();
        },
        [textEngine, refresh],
    );

    // One model's download, queued behind any other. A landing promotes the phone
    // when it can then run, if the reader's intent says so.
    const handleDownload = useCallback(
        async (modelId: string) => {
            const model = modelId === RELEVANCE_MODEL.modelId ? RELEVANCE_MODEL : TEXT_MODEL;
            const net = await NetInfo.fetch().catch(() => null);
            if (net?.type === 'cellular') {
                const ok = await showDialog({
                    title: t('meraProtocol.cellularTitle'),
                    body: t('meraProtocol.cellularBody', { size: `${gbText(model.sizeBytes)} GB` }),
                    confirmLabel: t('meraProtocol.cellularConfirm'),
                    cancelLabel: t('meraProtocol.cellularWait'),
                });
                if (!ok) return;
            }
            startModelDownloads({ modelIds: [modelId], promote: intentRef.current });
        },
        [t],
    );

    const handleCancelDownload = useCallback((modelId: string) => cancelModelDownload(modelId), []);

    // Deleting the relevance model turns On this phone off: processing falls back to cloud,
    // locally and on the server, BEFORE the file goes, and the intent is cleared. The server
    // write follows the intent, not the local mode, which is already Cloud when it cannot run.
    const fallBackToCloud = useCallback(async () => {
        if (useMeraProtocolStore.getState().processingMode !== ProcessingMode.OnDevice && !intentRef.current) return;
        try {
            const userId = await resolveCurrentUserId();
            await AccountService.updateProcessingMode(userId, ProcessingMode.Cloud);
            cacheProcessingMode(ProcessingMode.Cloud);
        } catch {
            // Server mutation failed. Still update locally so the UI reflects
            // reality; the next settings load will not re-promote OnDevice
            // without the models on disk.
        }
        useMeraProtocolStore.getState().setProcessingMode(ProcessingMode.Cloud);
    }, []);

    // Deleting the Mera text model while it writes the text: the built-in model takes over when it can
    // run, else the phone uses Private cloud on this phone only, with a toast. The intent is kept.
    const moveOffTextModel = useCallback(async () => {
        if (textEngine !== 'qwen') return;
        if (builtIn && nativeAvailable) {
            await setTextEngine(builtIn);
            resetInferenceStats();
            return;
        }
        if (useMeraProtocolStore.getState().processingMode === ProcessingMode.OnDevice || intentRef.current) {
            useMeraProtocolStore.getState().setProcessingMode(ProcessingMode.Cloud);
            toast.show({
                placement: 'top',
                render: () => (
                    <Toast action="info" variant="solid">
                        <ToastTitle>{t('meraProtocol.textModelGoneTitle')}</ToastTitle>
                        <ToastDescription>{t('meraProtocol.textModelGoneBody')}</ToastDescription>
                    </Toast>
                ),
            });
        }
    }, [textEngine, builtIn, nativeAvailable, toast, t]);

    const handleDeleteModel = useCallback(
        async (modelId: string) => {
            const relevance = modelId === RELEVANCE_MODEL.modelId;
            const model = relevance ? RELEVANCE_MODEL : TEXT_MODEL;
            const name = t(relevance ? 'meraProtocol.relevanceTitle' : 'meraProtocol.textMera');
            const ok = await showDialog({
                title: t('meraProtocol.deleteModelTitle', { name }),
                body: t(relevance ? 'meraProtocol.deleteRelevanceBody' : 'meraProtocol.deleteTextBody', {
                    size: `${gbText(model.sizeBytes)} GB`,
                }),
                confirmLabel: t('common.delete'),
                cancelLabel: t('common.cancel'),
                destructive: true,
            });
            if (!ok) return;
            deletingRef.current = true;
            setIsDeletingModel(true);
            try {
                if (relevance) {
                    await fallBackToCloud();
                    setOnDeviceIntent(false);
                    setPromoteWhenDone(false);
                    resetInferenceStats();
                } else {
                    await moveOffTextModel();
                }
                await deleteDownloadedModel(modelId);
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
                deletingRef.current = false;
                setIsDeletingModel(false);
            }
            // The built-in model may now run where the text model did.
            await refresh();
        },
        [fallBackToCloud, moveOffTextModel, refresh, toast, t],
    );

    return {
        isLoading,
        isUpdatingMode,
        requirementsResult,
        showRequirements,
        setShowRequirements,
        isDeletingModel,
        processingMode,
        isOnDevice,
        store,
        webSearchInChat,
        inferenceStats,
        deviceSupported,
        onDeviceIntent,
        bgRefreshEnabled,
        toggleBgRefresh,
        onDeviceNotes,
        toggleNotes,
        selectMode,
        refresh,
        runnable,
        waitingForNative,
        waitingLine,
        relevanceModel,
        textOptions,
        textEngine,
        builtInName,
        selectEngine,
        nativeAvailable,
        handleDownload,
        handleCancelDownload,
        handleDeleteModel,
    };
}
