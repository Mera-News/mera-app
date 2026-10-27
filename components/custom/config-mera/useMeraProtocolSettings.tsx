import MeraToast from '@/components/custom/toast/MeraToast';
import { useToast } from '@/components/ui/toast';
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
import { RELEVANCE_MODEL } from '@/lib/mera-protocol-toolkit/core/model-catalog';
import { builtInAvailability, builtInEngine } from '@/lib/mera-protocol-toolkit/core/text-engine';
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
import { rependSkippedNotes } from '@/lib/mera-protocol/scoring-service';
import {
    useChatInCloud,
    useMeraProtocolStore,
    useSkipNotes,
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
 * Why the built-in model (Apple Intelligence, Gemini Nano) cannot run now, by
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
    'meraProtocol.onPhoneIntro',
    'meraProtocol.inUseCloud',
    'meraProtocol.stepModelTitle',
    'meraProtocol.stepOnTitle',
    'meraProtocol.stepChatTitle',
    'meraProtocol.turnOn',
    'meraProtocol.chatInCloudTitle',
    'meraProtocol.chatInCloudNote',
    'meraProtocol.cantRun',
    'meraProtocol.cantRunHelpTitle',
    'meraProtocol.cantRunHelpIntro',
    'meraProtocol.helpModesCloud',
    'meraProtocol.helpModesPhone',
    'meraProtocol.builtInReady',
    'meraProtocol.builtInRequirement',
    'meraProtocol.notesGroup',
    'meraProtocol.skipNotesTitle',
    'meraProtocol.skipNotesLine',
    'meraProtocol.skipNotesHelp',
    'meraProtocol.fallbackNoticeTitle',
    'meraProtocol.fallbackNoticeBody',
    'meraProtocol.modelsWaitingNative',
    'meraProtocol.modelQueued',
    'meraProtocol.modelRowReady',
    'meraProtocol.modelRowMissing',
    'meraProtocol.modelLicenseLink',
    'meraProtocol.downloadAction',
    'meraProtocol.downloadingOf',
    'meraProtocol.cancelDownloadAction',
    'meraProtocol.tryAgain',
    'meraProtocol.deleteModelTitle',
    'meraProtocol.deleteRelevanceBody',
    'meraProtocol.deleteFailedDescription',
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
    'meraProtocol.speedRanking',
    'meraProtocol.speedNotes',
    'meraProtocol.speedRefused',
    'meraProtocol.speedResetNote',
    'download.onDeviceReady',
    'download.relevanceDone',
    'download.modelDownloading',
    ...Object.values(NATIVE_REASON_KEYS),
] as const;

/** Keeps the cached server persona in step with a mode the server just accepted (the boot purge reads it). */
function cacheProcessingMode(mode: ProcessingMode): void {
    const persona = useUserStore.getState().userPersona;
    if (persona) useUserStore.getState().setUserPersona({ ...persona, processingMode: mode });
}

type ModelsStatus = Awaited<ReturnType<typeof onDeviceModelsStatus>>;

/** The downloadable model's row: the Mera relevance model. Every on-device row is Beta (D30). */
export type ModelRowState = {
    modelId: string;
    titleKey: 'meraProtocol.relevanceTitle';
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

/** The built-in text model's status row (no picker, no download, D37). */
export type BuiltInStatus = {
    /** "Apple Intelligence" or "Gemini Nano". */
    name: string;
    available: boolean;
    /** Why it cannot run now (already translated); null when it can. */
    reason: string | null;
    beta: true;
};

export function useMeraProtocolSettings() {
    const { t } = useTranslation();
    const [isLoading, setIsLoading] = useState(true);
    const [isUpdatingMode, setIsUpdatingMode] = useState(false);
    const [requirementsResult, setRequirementsResult] = useState<SystemRequirementsResult | null>(null);
    const [isDeletingModel, setIsDeletingModel] = useState(false);
    // Each model on disk or not, and whether On this phone can run.
    const [status, setStatus] = useState<ModelsStatus | null>(null);
    // The built-in model's availability, re-read on every focus (it can change while the app runs).
    const [native, setNative] = useState<OnDeviceLlmAvailability | null>(null);
    // This platform's built-in model, if the native module is there: 'afm' on iOS, 'nano' on Android.
    const builtIn = builtInEngine();

    const processingMode = useProcessingMode();
    const isOnDevice = processingMode === ProcessingMode.OnDevice;
    const store = useMeraProtocolStore();
    const webSearchInChat = useWebSearchInChat();
    const skipNotes = useSkipNotes();
    // Chat in Private cloud while On this phone runs the feed (lib/llm/chat-cloud.ts).
    const chatInCloud = useChatInCloud();
    const inferenceStats = useInferenceStats();
    const downloads = useModelDownloads();

    const toast = useToast();

    const runnable = status?.runnable ?? false;
    const nativeAvailable = native?.available ?? false;
    const builtInName = builtIn ? BUILT_IN_MODEL_NAME[builtIn] : null;

    const deviceSupported = requirementsResult ? requirementsResult.supported : null;
    const onDeviceAvailable = deviceSupported !== false && runnable;
    const freeGb = requirementsResult?.deviceInfo.freeStorageGB ?? null;

    const modelRow = (m: typeof RELEVANCE_MODEL, titleKey: ModelRowState['titleKey']): ModelRowState => {
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
    // Whether the server persona holds On this phone, so looking back at Private cloud writes nothing.
    const serverOnDeviceRef = useRef(false);

    // The built-in model writes the text: a status row with its availability reason, shown only on
    // its platform. It never needs a download.
    const builtInStatus: BuiltInStatus | null =
        builtInName && native != null && native.reason !== 'unsupportedPlatform'
            ? {
                  name: builtInName,
                  available: nativeAvailable,
                  reason:
                      !nativeAvailable && native.reason ? t(NATIVE_REASON_KEYS[native.reason], { name: builtInName }) : null,
                  beta: true,
              }
            : null;

    // Kev is on disk and the built-in model cannot run yet: without a line the section would show
    // everything downloaded and no way forward.
    const waitingForNative = onDeviceIntent && status != null && !runnable && relevanceModel.onDisk;
    const waitingLine = waitingForNative && builtInName ? t('meraProtocol.modelsWaitingNative', { name: builtInName }) : null;

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
    // intent are kept). The move is visible: this screen shows the mode and why it cannot run.
    // Not held off by a running download: Kev's landing promotes by itself.
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

    // Skip notes (D42), both modes. Turned off, rows finalised without a note are owed one again;
    // in the cloud the orphaned-reasons sweep is kicked now rather than at the next sync.
    const toggleSkipNotes = useCallback(() => {
        const next = !skipNotes;
        useMeraProtocolStore.getState().setSkipNotes(next);
        if (next) return;
        void (async () => {
            await rependSkippedNotes();
            if (useMeraProtocolStore.getState().processingMode === ProcessingMode.OnDevice) return;
            // Lazy: the cloud pipeline reaches the database and the gateway at import.
            // eslint-disable-next-line @typescript-eslint/no-require-imports
            const pipeline = require('@/lib/services/scoring-pipeline') as typeof import('@/lib/services/scoring-pipeline');
            await pipeline.enqueueOrphanedReasons();
        })().catch((err) =>
            logger.captureException(err, { tags: { component: 'MeraProtocolSettings', method: 'rependSkippedNotes' } }),
        );
    }, [skipNotes]);

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
                serverOnDeviceRef.current = wantsOnDevice;
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
                    <MeraToast
                        tone="error"
                        title={t('meraProtocol.loadFailedTitle')}
                        body={t('meraProtocol.loadFailedDescription')}
                    />
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
        // Read before setPromoteWhenDone: a promoting download already wrote On this phone
        // (saveIntentForDownload), and so did a landing that could not run yet (the cached persona).
        const serverOnDevice =
            serverOnDeviceRef.current ||
            willPromoteWhenDone() ||
            useUserStore.getState().userPersona?.processingMode === ProcessingMode.OnDevice;

        // Always reflect intent locally: it drives the help line and the download rows.
        setOnDeviceIntent(wantsOnDevice);
        // A download in flight follows the reader's latest choice.
        setPromoteWhenDone(wantsOnDevice);

        // If on-device isn't runnable yet, the contextual UI we just revealed
        // is the feedback. Don't persist or toast.
        if (wantsOnDevice && !onDeviceAvailable) return;
        // Back on Private cloud after only looking at the other tab: the server already holds it.
        if (!wantsOnDevice && processingMode === ProcessingMode.Cloud && !serverOnDevice) return;
        if (mode === processingMode && wantsOnDevice === hadIntent) return;

        setIsUpdatingMode(true);
        try {
            const userId = await resolveCurrentUserId();
            await AccountService.updateProcessingMode(userId, mode);
            serverOnDeviceRef.current = wantsOnDevice;
            store.setProcessingMode(mode);
            cacheProcessingMode(mode);

            toast.show({
                placement: 'top',
                render: () => (
                    <MeraToast
                        tone="success"
                        title={wantsOnDevice ? t('meraProtocol.modeUpdatedOnDeviceTitle') : t('meraProtocol.modeUpdatedCloudTitle')}
                        body={wantsOnDevice ? t('meraProtocol.modeUpdatedOnDeviceDescription') : t('meraProtocol.modeUpdatedCloudDescription')}
                    />
                ),
            });
        } catch {
            // The server still holds what it held: the intent goes back with it.
            setOnDeviceIntent(hadIntent);
            toast.show({
                placement: 'top',
                render: () => (
                    <MeraToast
                        tone="error"
                        title={t('meraProtocol.settingUpdateFailedTitle')}
                        body={t('meraProtocol.settingUpdateFailedDescription')}
                    />
                ),
            });
        } finally {
            setIsUpdatingMode(false);
        }
    };

    // The model's download. A landing promotes the phone when it can then run, if the reader's
    // intent says so.
    const handleDownload = useCallback(
        async (modelId: string) => {
            const model = RELEVANCE_MODEL;
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
            serverOnDeviceRef.current = false;
            cacheProcessingMode(ProcessingMode.Cloud);
        } catch {
            // Server mutation failed. Still update locally so the UI reflects
            // reality; the next settings load will not re-promote OnDevice
            // without the models on disk.
        }
        useMeraProtocolStore.getState().setProcessingMode(ProcessingMode.Cloud);
    }, []);

    const handleDeleteModel = useCallback(
        async (modelId: string) => {
            const name = t('meraProtocol.relevanceTitle');
            const ok = await showDialog({
                title: t('meraProtocol.deleteModelTitle', { name }),
                body: t('meraProtocol.deleteRelevanceBody', { size: `${gbText(RELEVANCE_MODEL.sizeBytes)} GB` }),
                confirmLabel: t('common.delete'),
                cancelLabel: t('common.cancel'),
                destructive: true,
            });
            if (!ok) return;
            deletingRef.current = true;
            setIsDeletingModel(true);
            try {
                await fallBackToCloud();
                setOnDeviceIntent(false);
                setPromoteWhenDone(false);
                resetInferenceStats();
                await deleteDownloadedModel(modelId);
            } catch {
                toast.show({
                    placement: 'top',
                    render: () => (
                        <MeraToast
                            tone="error"
                            title={t('meraProtocol.deleteFailedTitle')}
                            body={t('meraProtocol.deleteFailedDescription')}
                        />
                    ),
                });
            } finally {
                deletingRef.current = false;
                setIsDeletingModel(false);
            }
            await refresh();
        },
        [fallBackToCloud, refresh, toast, t],
    );

    return {
        isLoading,
        isUpdatingMode,
        requirementsResult,
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
        skipNotes,
        toggleSkipNotes,
        chatInCloud,
        toggleChatInCloud: () => store.setChatInCloud(!chatInCloud),
        selectMode,
        refresh,
        runnable,
        waitingForNative,
        waitingLine,
        relevanceModel,
        builtInStatus,
        builtInName,
        nativeAvailable,
        handleDownload,
        handleCancelDownload,
        handleDeleteModel,
    };
}
