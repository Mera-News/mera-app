import { deleteSetting, getSetting, setSetting } from '@/lib/database/services/setting-service';
import { ProcessingMode } from '@/lib/generated/graphql-types';
import logger from '@/lib/logger';
import { create } from 'zustand';

type ModelStateLabel =
  | 'not_downloaded'
  | 'downloading'
  | 'downloaded'
  | 'loading'
  | 'ready'
  | 'error';

interface MeraProtocolState {
  // Server-synced processing mode (cached locally)
  processingMode: ProcessingMode;

  // Noise injection — when true, every topic-gen pass emits NOISE_MULTIPLIER
  // decoy topics per real topic. Server never learns which are which; the app
  // discards clusters that only matched noisy topics at sync time.
  injectNoise: boolean;

  // Relevance fetching v2 — when true, candidates carrying server tags route
  // through the deterministic math scoring engine (geo / event / entity
  // components + the judge pass) and keep an unbucketed score. Off is the
  // legacy two-pass LLM tier path, byte-identical to before this flag existed.
  // Inert until the server's article-tagging stage populates geo_tags /
  // entities / event_type — untagged candidates stay on the legacy path either
  // way (see `isBackstop` in scoring-engine/relevance.ts).
  relevanceV2: boolean;

  // Model lifecycle
  selectedModelId: string; // Which model the user has chosen
  modelState: ModelStateLabel;
  downloadProgress: number; // 0–100
  modelError: string | null;

  // Article processing
  isProcessing: boolean;
  processProgress: number; // 0–1
  processedCount: number;
  totalCount: number;

  // Actions — protocol
  setProcessingMode: (mode: ProcessingMode) => void;
  setInjectNoise: (enabled: boolean) => void;
  setRelevanceV2: (enabled: boolean) => void;
  setSelectedModelId: (modelId: string) => void;
  setModelState: (state: ModelStateLabel) => void;
  setDownloadProgress: (progress: number) => void;
  setModelError: (error: string | null) => void;

  // Actions — processing
  startProcessing: (totalCount: number) => void;
  updateProgress: (processedCount: number) => void;
  finishProcessing: () => void;

  // Reset & hydrate
  reset: () => void;
  hydrateFromDb: () => Promise<void>;
}

const DEFAULT_SELECTED_MODEL_ID = 'mera-qwen3.5-4b';

const DEFAULT_PROCESSING_MODE: ProcessingMode = ProcessingMode.Cloud;

const SETTING_PROCESSING_MODE = 'mera_processing_mode';
const SETTING_INJECT_NOISE = 'mera_inject_noise';
const SETTING_RELEVANCE_V2 = 'mera_relevance_v2';
const LEGACY_SETTING_PROTOCOL_ENABLED = 'mera_protocol_enabled';
/** Retired with the legacy questionnaire-level persona flow. Never read — kept
 *  only so `reset()` clears the orphaned row from devices that persisted it. */
const RETIRED_SETTING_LEGACY_PERSONA_UPDATE = 'mera_legacy_persona_update';

const initialState = {
  processingMode: DEFAULT_PROCESSING_MODE,
  injectNoise: false,
  relevanceV2: false,
  selectedModelId: DEFAULT_SELECTED_MODEL_ID,
  modelState: 'not_downloaded' as ModelStateLabel,
  downloadProgress: 0,
  modelError: null as string | null,
  isProcessing: false,
  processProgress: 0,
  processedCount: 0,
  totalCount: 0,
};

export const useMeraProtocolStore = create<MeraProtocolState>((set) => ({
  ...initialState,

  setProcessingMode: (processingMode) => {
    set({ processingMode });
    setSetting(SETTING_PROCESSING_MODE, processingMode).catch(() => { });
  },

  setInjectNoise: (injectNoise) => {
    set({ injectNoise });
    setSetting(SETTING_INJECT_NOISE, injectNoise ? 'true' : 'false').catch(() => { });
  },

  setRelevanceV2: (relevanceV2) => {
    set({ relevanceV2 });
    setSetting(SETTING_RELEVANCE_V2, relevanceV2 ? 'true' : 'false').catch(() => { });
  },

  setSelectedModelId: (selectedModelId) => {
    set({ selectedModelId });
    setSetting('mera_selected_model_id', selectedModelId).catch(() => { });
  },

  setModelState: (modelState) => set({ modelState, modelError: null }),

  setDownloadProgress: (downloadProgress) => set({ downloadProgress }),

  setModelError: (modelError) =>
    set({ modelError, modelState: 'error' }),

  startProcessing: (totalCount) =>
    set({
      isProcessing: true,
      processProgress: 0,
      processedCount: 0,
      totalCount,
    }),

  updateProgress: (processedCount) =>
    set((state) => ({
      processedCount,
      processProgress:
        state.totalCount > 0 ? processedCount / state.totalCount : 0,
    })),

  finishProcessing: () =>
    set((state) => ({
      isProcessing: false,
      processProgress: 1,
      processedCount: state.totalCount,
    })),

  reset: () => {
    set(initialState);
    deleteSetting(SETTING_PROCESSING_MODE).catch(() => { });
    deleteSetting(LEGACY_SETTING_PROTOCOL_ENABLED).catch(() => { });
    deleteSetting('mera_selected_model_id').catch(() => { });
    deleteSetting(SETTING_INJECT_NOISE).catch(() => { });
    deleteSetting(SETTING_RELEVANCE_V2).catch(() => { });
    deleteSetting(RETIRED_SETTING_LEGACY_PERSONA_UPDATE).catch(() => { });
    deleteSetting('e2ee_enabled').catch(() => { });
  },

  hydrateFromDb: async () => {
    try {
      const [modeValue, legacyEnabledValue, modelIdValue, injectNoiseValue, relevanceV2Value] =
        await Promise.all([
          getSetting(SETTING_PROCESSING_MODE),
          getSetting(LEGACY_SETTING_PROTOCOL_ENABLED),
          getSetting('mera_selected_model_id'),
          getSetting(SETTING_INJECT_NOISE),
          getSetting(SETTING_RELEVANCE_V2),
        ]);
      const updates: Partial<MeraProtocolState> = {};
      if (modeValue === ProcessingMode.OnDevice || modeValue === ProcessingMode.Cloud) {
        updates.processingMode = modeValue;
      } else if (legacyEnabledValue !== null) {
        // One-shot migration from the pre-enum boolean setting.
        const migrated =
          legacyEnabledValue === 'true'
            ? ProcessingMode.OnDevice
            : ProcessingMode.Cloud;
        updates.processingMode = migrated;
        setSetting(SETTING_PROCESSING_MODE, migrated).catch(() => { });
        deleteSetting(LEGACY_SETTING_PROTOCOL_ENABLED).catch(() => { });
      }
      if (modelIdValue !== null) {
        updates.selectedModelId = modelIdValue;
      }
      if (injectNoiseValue === 'true') {
        updates.injectNoise = true;
      } else if (injectNoiseValue === 'false') {
        updates.injectNoise = false;
      }
      if (relevanceV2Value === 'true') {
        updates.relevanceV2 = true;
      } else if (relevanceV2Value === 'false') {
        updates.relevanceV2 = false;
      }
      if (Object.keys(updates).length > 0) {
        set(updates);
      }
    } catch (err) {
      logger.warn('[mera-protocol-store] hydrateFromDb failed', { error: String(err) });
    }
  },
}));

// Selector hooks
export const useProcessingMode = () =>
  useMeraProtocolStore((state) => state.processingMode);

export const useIsOnDeviceProcessing = () =>
  useMeraProtocolStore((state) => state.processingMode === ProcessingMode.OnDevice);

export const useInjectNoise = () =>
  useMeraProtocolStore((state) => state.injectNoise);

export const useRelevanceV2 = () =>
  useMeraProtocolStore((state) => state.relevanceV2);

export const useSelectedModelId = () =>
  useMeraProtocolStore((state) => state.selectedModelId);

export const useModelState = () =>
  useMeraProtocolStore((state) => state.modelState);

export const useDownloadProgress = () =>
  useMeraProtocolStore((state) => state.downloadProgress);

export const useIsModelReady = () =>
  useMeraProtocolStore((state) => state.modelState === 'ready');

export const useIsProcessing = () =>
  useMeraProtocolStore((state) => state.isProcessing);

export const useProcessProgress = () =>
  useMeraProtocolStore((state) => ({
    progress: state.processProgress,
    processed: state.processedCount,
    total: state.totalCount,
  }));
