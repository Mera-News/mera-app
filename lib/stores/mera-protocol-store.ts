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

  // Relevance scoring v4 — when true, the classic two-pass cloud path ALSO
  // (a) shows each article's server tag metadata to the pass-1 scoring prompt
  // and (b) skips the pass-2 note call for low-value event types, demoting
  // those rows. One switch drives both `articlePipeline.legacyTagPromptEnabled`
  // and `legacyTagReasonGateEnabled`: they were measured together and ship
  // together. Routing is unchanged either way — v4 is still the legacy path.
  //
  // This field is the SAME user preference the retired "relevance v3" beta
  // switch drove (v3 was single-pass two-axis scoring, now deleted); only the
  // symbol was renamed. See `SETTING_RELEVANCE_V4` for why the persisted key
  // still reads `mera_relevance_v3`. Default false.
  relevanceV4: boolean;

  // Web search in chat — when true, Mera may call the `webSearch` tool, which
  // sends the SEARCH WORDS (and nothing else) to our inference gateway and on
  // to a search provider. Default false, and the default is load-bearing: the
  // tool DECLARATION is omitted from the turn payload while this is false, so
  // an off toggle costs zero prompt tokens and can make zero network calls.
  webSearchInChat: boolean;

  // Deep interview — when true, the persona interview draws from a deeper
  // question bank (attention, anxiety, time sinks, decisions, why a place
  // matters). The answers become richer LOCAL facts, exactly like every other
  // fact: they never leave the device. Default false.
  deepInterview: boolean;

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
  setRelevanceV4: (enabled: boolean) => void;
  setWebSearchInChat: (enabled: boolean) => void;
  setDeepInterview: (enabled: boolean) => void;
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
/**
 * THE STRING STILL SAYS v3 ON PURPOSE. This row is the *same* user preference
 * the "relevance v3" beta switch wrote; v3's scorer was retired and the switch
 * repurposed as v4 (the legacy path plus the two measured article-tag
 * features). Minting a fresh key would read as absent on every device that had
 * the beta on and silently switch those users OFF — a settings key is user
 * data, and renaming it is a migration, not a rename. Only the symbol changed.
 */
const SETTING_RELEVANCE_V4 = 'mera_relevance_v3';
const SETTING_WEB_SEARCH_IN_CHAT = 'mera_web_search_in_chat';
const SETTING_DEEP_INTERVIEW = 'mera_deep_interview';
const LEGACY_SETTING_PROTOCOL_ENABLED = 'mera_protocol_enabled';
/** Retired with the legacy questionnaire-level persona flow. Never read — kept
 *  only so `reset()` clears the orphaned row from devices that persisted it. */
const RETIRED_SETTING_LEGACY_PERSONA_UPDATE = 'mera_legacy_persona_update';
/** Retired with the relevance-v2 math-authoritative toggle (superseded first by
 *  v3, now by v4). Never read — the switch starts off regardless of what v2 was
 *  set to — kept only so
 *  `reset()`/`hydrateFromDb` clear the orphaned row from devices that
 *  persisted it. */
const RETIRED_SETTING_RELEVANCE_V2 = 'mera_relevance_v2';

const initialState = {
  processingMode: DEFAULT_PROCESSING_MODE,
  injectNoise: false,
  relevanceV4: false,
  webSearchInChat: false,
  deepInterview: false,
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

  setRelevanceV4: (relevanceV4) => {
    set({ relevanceV4 });
    setSetting(SETTING_RELEVANCE_V4, relevanceV4 ? 'true' : 'false').catch(() => { });
  },

  setWebSearchInChat: (webSearchInChat) => {
    set({ webSearchInChat });
    setSetting(SETTING_WEB_SEARCH_IN_CHAT, webSearchInChat ? 'true' : 'false').catch(() => { });
  },

  setDeepInterview: (deepInterview) => {
    set({ deepInterview });
    setSetting(SETTING_DEEP_INTERVIEW, deepInterview ? 'true' : 'false').catch(() => { });
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
    deleteSetting(SETTING_RELEVANCE_V4).catch(() => { });
    deleteSetting(SETTING_WEB_SEARCH_IN_CHAT).catch(() => { });
    deleteSetting(SETTING_DEEP_INTERVIEW).catch(() => { });
    deleteSetting(RETIRED_SETTING_RELEVANCE_V2).catch(() => { });
    deleteSetting(RETIRED_SETTING_LEGACY_PERSONA_UPDATE).catch(() => { });
    deleteSetting('e2ee_enabled').catch(() => { });
  },

  hydrateFromDb: async () => {
    try {
      const [
        modeValue,
        legacyEnabledValue,
        modelIdValue,
        injectNoiseValue,
        relevanceV4Value,
        webSearchValue,
        deepInterviewValue,
      ] = await Promise.all([
        getSetting(SETTING_PROCESSING_MODE),
        getSetting(LEGACY_SETTING_PROTOCOL_ENABLED),
        getSetting('mera_selected_model_id'),
        getSetting(SETTING_INJECT_NOISE),
        getSetting(SETTING_RELEVANCE_V4),
        getSetting(SETTING_WEB_SEARCH_IN_CHAT),
        getSetting(SETTING_DEEP_INTERVIEW),
      ]);
      // One-shot cleanup: the retired v2 key is never read — the switch starts
      // off regardless of what v2 was set to — just swept so it doesn't linger.
      deleteSetting(RETIRED_SETTING_RELEVANCE_V2).catch(() => { });
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
      if (relevanceV4Value === 'true') {
        updates.relevanceV4 = true;
      } else if (relevanceV4Value === 'false') {
        updates.relevanceV4 = false;
      }
      // ABSENT ⇒ OFF, deliberately: only an explicit 'true' turns either of
      // these on. A device that has never seen the toggle must not inherit an
      // on state from a missing row — for webSearchInChat that is the
      // difference between a query leaving the device and not.
      if (webSearchValue === 'true') {
        updates.webSearchInChat = true;
      } else if (webSearchValue === 'false') {
        updates.webSearchInChat = false;
      }
      if (deepInterviewValue === 'true') {
        updates.deepInterview = true;
      } else if (deepInterviewValue === 'false') {
        updates.deepInterview = false;
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

export const useRelevanceV4 = () =>
  useMeraProtocolStore((state) => state.relevanceV4);

export const useWebSearchInChat = () =>
  useMeraProtocolStore((state) => state.webSearchInChat);

export const useDeepInterview = () =>
  useMeraProtocolStore((state) => state.deepInterview);

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
