import { deleteSetting, getSetting, setSetting } from '@/lib/database/services/setting-service';
import { ProcessingMode } from '@/lib/generated/graphql-types';
import logger from '@/lib/logger';
import {
  DEFAULT_MODEL_ID,
  isRetiredModelId,
} from '@/lib/mera-protocol-toolkit/core/model-catalog';
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

  // Web search in chat — when true, Mera may call the `webSearch` tool, which
  // sends the SEARCH WORDS (and nothing else) to our inference gateway and on
  // to a search provider. Default false, and the default is load-bearing: the
  // tool DECLARATION is omitted from the turn payload while this is false, so
  // an off toggle costs zero prompt tokens and can make zero network calls.
  webSearchInChat: boolean;

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
  setWebSearchInChat: (enabled: boolean) => void;
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

const DEFAULT_SELECTED_MODEL_ID = DEFAULT_MODEL_ID;

const DEFAULT_PROCESSING_MODE: ProcessingMode = ProcessingMode.Cloud;

const SETTING_PROCESSING_MODE = 'mera_processing_mode';
const SETTING_INJECT_NOISE = 'mera_inject_noise';
const SETTING_WEB_SEARCH_IN_CHAT = 'mera_web_search_in_chat';
// RETIRED. Fact checking is part of the product now rather than an opt-in, so
// this key is no longer READ — only swept, so a device that once stored 'false'
// does not keep a row implying a preference the app no longer honours.
//
// Sweeping rather than migrating is the decision, not an oversight: an explicit
// 'false' is deliberately NOT carried forward anywhere, because the switch it
// belonged to no longer exists. Anyone who had turned fact checks off now gets
// them, which is what "part of the product" means.
const RETIRED_SETTING_FACT_CHECK = 'mera_fact_check';
/**
 * One-shot marker for the web-search default flip.
 *
 * Web search used to be opt-in and OFF, and the flip to on-by-default was a
 * deliberate product decision to reach EVERY device, not just fresh installs —
 * so the first hydrate after the update DELETES whatever
 * `mera_web_search_in_chat` held, including an explicit 'false', and writes
 * this marker. Same shape as the retired fact-check sweep above and for the
 * same reason: a stored preference for a default that no longer exists is not
 * a preference anyone expressed about the current app.
 *
 * It is a marker and NOT a retirement: the toggle is still on the Mera Protocol
 * screen, so an opt-out made AFTER the flip is honoured forever. Only the one
 * pre-flip value is discarded, and only once.
 */
const SETTING_WEB_SEARCH_FORCED_ON = 'mera_web_search_forced_on_v1';
const LEGACY_SETTING_PROTOCOL_ENABLED = 'mera_protocol_enabled';
/** Retired with the legacy questionnaire-level persona flow. Never read — kept
 *  only so `reset()` clears the orphaned row from devices that persisted it. */
const RETIRED_SETTING_LEGACY_PERSONA_UPDATE = 'mera_legacy_persona_update';
/** Retired with the relevance-v2 math-authoritative toggle. Never read; kept
 *  only so `reset()`/`hydrateFromDb` clear the orphaned row from devices that
 *  persisted it. */
const RETIRED_SETTING_RELEVANCE_V2 = 'mera_relevance_v2';

const initialState = {
  processingMode: DEFAULT_PROCESSING_MODE,
  injectNoise: false,
  // ON by default since the web-search wave. Its twin — the marker branch in
  // `hydrateFromDb` — must agree, or the hydrate overwrites this on every
  // existing device and the feature ships dark.
  webSearchInChat: true,
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

  setWebSearchInChat: (webSearchInChat) => {
    set({ webSearchInChat });
    setSetting(SETTING_WEB_SEARCH_IN_CHAT, webSearchInChat ? 'true' : 'false').catch(() => { });
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
    deleteSetting(SETTING_WEB_SEARCH_IN_CHAT).catch(() => { });
    // The marker goes too. A reset device is a fresh device, and a fresh device
    // gets the current default — leaving the marker behind would make the next
    // hydrate honour an absent row as "on" anyway, but leaving it AND a stale
    // value behind is how a reset silently preserves a preference it just
    // deleted.
    deleteSetting(SETTING_WEB_SEARCH_FORCED_ON).catch(() => { });
    deleteSetting(RETIRED_SETTING_FACT_CHECK).catch(() => { });
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
        webSearchValue,
        webSearchForcedOnValue,
      ] = await Promise.all([
        getSetting(SETTING_PROCESSING_MODE),
        getSetting(LEGACY_SETTING_PROTOCOL_ENABLED),
        getSetting('mera_selected_model_id'),
        getSetting(SETTING_INJECT_NOISE),
        getSetting(SETTING_WEB_SEARCH_IN_CHAT),
        getSetting(SETTING_WEB_SEARCH_FORCED_ON),
      ]);
      // One-shot cleanup: the retired v2 key is never read, just swept so it
      // doesn't linger.
      deleteSetting(RETIRED_SETTING_RELEVANCE_V2).catch(() => { });
      deleteSetting(RETIRED_SETTING_FACT_CHECK).catch(() => { });
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
        if (isRetiredModelId(modelIdValue)) {
          // A retired model is no longer offered. Remap it to the default and
          // rewrite the row, so a restored old backup cannot bring it back.
          // Its files are deleted at boot by retireLegacyModels().
          updates.selectedModelId = DEFAULT_SELECTED_MODEL_ID;
          setSetting('mera_selected_model_id', DEFAULT_SELECTED_MODEL_ID).catch(() => { });
        } else {
          updates.selectedModelId = modelIdValue;
        }
      }
      if (injectNoiseValue === 'true') {
        updates.injectNoise = true;
      } else if (injectNoiseValue === 'false') {
        updates.injectNoise = false;
      }
      // WEB SEARCH: ABSENT ⇒ ON, and a one-shot sweep of whatever came before.
      //
      // This is the exact inverse of the rule that used to live here, and the
      // reversal is the decision, not a slip. The old comment read "a device
      // that has never seen the toggle must not inherit an on state from a
      // missing row"; web search is now part of the product rather than an
      // opt-in, so an absent row means the default, and the default is on.
      //
      // The marker makes the sweep happen ONCE. Before it exists, any stored
      // value — including an explicit 'false' set while the feature was opt-in
      // — is deleted and the setting comes up on. After it exists, an explicit
      // 'false' is honoured forever, because that one was chosen against the
      // current default by a user looking at the current switch.
      if (webSearchForcedOnValue !== 'true') {
        updates.webSearchInChat = true;
        deleteSetting(SETTING_WEB_SEARCH_IN_CHAT).catch(() => { });
        setSetting(SETTING_WEB_SEARCH_FORCED_ON, 'true').catch(() => { });
      } else {
        updates.webSearchInChat = webSearchValue !== 'false';
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

export const useWebSearchInChat = () =>
  useMeraProtocolStore((state) => state.webSearchInChat);

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
