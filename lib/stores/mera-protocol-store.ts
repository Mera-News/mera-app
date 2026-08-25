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

  // Show extracted metadata — when true, the article/suggestion detail
  // screens show the server's machine-extracted tags for the open story
  // (places, entities, event type). Transparency-only: no data path changes,
  // no network calls added — the fields already ride the existing
  // `articleById` query and the local suggestion row. Off by default because
  // this metadata is measurably imperfect (audited well below 100% correct)
  // and displaying it as fact would overclaim.
  showExtractedMetadata: boolean;

  // Auto community fact check — OFF by default, and the default is the point.
  //
  // A fact check is cached on our server against the ARTICLE, so one reader's
  // request is an answer for everybody. Showing it automatically means asking
  // the server "does this article have a check?" every time an article is
  // OPENED, which on the suggestion screen is a round trip and on the detail
  // screen is a field on a query already being made.
  //
  // That is a reasonable thing to want and a reasonable thing to decline, so it
  // is a switch rather than a decision made for the reader. OFF means the
  // lookup happens only when they tap the fact-check button — a deliberate act
  // on one article, which is exactly how the privacy policy describes it.
  //
  // ABSENT ⇒ OFF, the normal rule. This setting is new and opt-in; nobody has
  // consented to it yet, and a default that opted everyone in would be the
  // whole point of the switch, missed.
  //
  // It is now the ONLY fact-check switch. The `factCheckEnabled` toggle that
  // used to sit above it is gone: fact checking is part of the product, not
  // something to turn on. What remains a choice is not WHETHER checks exist,
  // but whether Mera goes looking for one on every article opened.
  autoCommunityFactCheck: boolean;

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
  setShowExtractedMetadata: (enabled: boolean) => void;
  setAutoCommunityFactCheck: (enabled: boolean) => void;
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
const SETTING_SHOW_EXTRACTED_METADATA = 'mera_show_extracted_metadata';
/**
 * Names the durable concept (fact-checking), not the current BETA status or
 * the off-by-default state — a settings key is user data, and renaming it
 * later would be a migration. See `SETTING_RELEVANCE_V4` above for the
 * cautionary precedent.
 */
// RETIRED. Fact checking is part of the product now rather than an opt-in, so
// this key is no longer READ — only swept, so a device that once stored 'false'
// does not keep a row implying a preference the app no longer honours.
//
// Sweeping rather than migrating is the decision, not an oversight: an explicit
// 'false' is deliberately NOT carried forward anywhere, because the switch it
// belonged to no longer exists. Anyone who had turned fact checks off now gets
// them, which is what "part of the product" means.
const RETIRED_SETTING_FACT_CHECK = 'mera_fact_check';
const SETTING_AUTO_COMMUNITY_FACT_CHECK = 'mera_auto_community_fact_check';
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
  // ON by default since the web-search wave. Its twin — the marker branch in
  // `hydrateFromDb` — must agree, or the hydrate overwrites this on every
  // existing device and the feature ships dark.
  webSearchInChat: true,
  deepInterview: false,
  showExtractedMetadata: false,
  // ON by default. Its twin — the absent branch in `hydrateFromDb` — must
  // agree, or the hydrate immediately overwrites this on every existing
  // device and the feature ships dark.
  autoCommunityFactCheck: false,
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

  setShowExtractedMetadata: (showExtractedMetadata) => {
    set({ showExtractedMetadata });
    setSetting(SETTING_SHOW_EXTRACTED_METADATA, showExtractedMetadata ? 'true' : 'false').catch(() => { });
  },

  setAutoCommunityFactCheck: (autoCommunityFactCheck: boolean) => {
    set({ autoCommunityFactCheck });
    setSetting(
      SETTING_AUTO_COMMUNITY_FACT_CHECK,
      autoCommunityFactCheck ? 'true' : 'false',
    ).catch(() => { });
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
    // The marker goes too. A reset device is a fresh device, and a fresh device
    // gets the current default — leaving the marker behind would make the next
    // hydrate honour an absent row as "on" anyway, but leaving it AND a stale
    // value behind is how a reset silently preserves a preference it just
    // deleted.
    deleteSetting(SETTING_WEB_SEARCH_FORCED_ON).catch(() => { });
    deleteSetting(SETTING_DEEP_INTERVIEW).catch(() => { });
    deleteSetting(SETTING_SHOW_EXTRACTED_METADATA).catch(() => { });
    deleteSetting(RETIRED_SETTING_FACT_CHECK).catch(() => { });
    deleteSetting(SETTING_AUTO_COMMUNITY_FACT_CHECK).catch(() => { });
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
        showExtractedMetadataValue,
        autoCommunityFactCheckValue,
        webSearchForcedOnValue,
      ] = await Promise.all([
        getSetting(SETTING_PROCESSING_MODE),
        getSetting(LEGACY_SETTING_PROTOCOL_ENABLED),
        getSetting('mera_selected_model_id'),
        getSetting(SETTING_INJECT_NOISE),
        getSetting(SETTING_RELEVANCE_V4),
        getSetting(SETTING_WEB_SEARCH_IN_CHAT),
        getSetting(SETTING_DEEP_INTERVIEW),
        getSetting(SETTING_SHOW_EXTRACTED_METADATA),
        getSetting(SETTING_AUTO_COMMUNITY_FACT_CHECK),
        getSetting(SETTING_WEB_SEARCH_FORCED_ON),
      ]);
      // One-shot cleanup: the retired v2 key is never read — the switch starts
      // off regardless of what v2 was set to — just swept so it doesn't linger.
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
      //
      // `deepInterview` below keeps the old absent ⇒ OFF rule. It is not the
      // same kind of setting: it changes what Mera ASKS the user, and nothing
      // about it became part of the product.
      if (webSearchForcedOnValue !== 'true') {
        updates.webSearchInChat = true;
        deleteSetting(SETTING_WEB_SEARCH_IN_CHAT).catch(() => { });
        setSetting(SETTING_WEB_SEARCH_FORCED_ON, 'true').catch(() => { });
      } else {
        updates.webSearchInChat = webSearchValue !== 'false';
      }
      if (deepInterviewValue === 'true') {
        updates.deepInterview = true;
      } else if (deepInterviewValue === 'false') {
        updates.deepInterview = false;
      }
      if (showExtractedMetadataValue === 'true') {
        updates.showExtractedMetadata = true;
      } else if (showExtractedMetadataValue === 'false') {
        updates.showExtractedMetadata = false;
      }
      // Only an explicit 'true' opts in — see the field's comment for why this
      // does NOT copy the absent ⇒ ON exception directly above it.
      if (autoCommunityFactCheckValue === 'true') {
        updates.autoCommunityFactCheck = true;
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

export const useShowExtractedMetadata = () =>
  useMeraProtocolStore((state) => state.showExtractedMetadata);


/** Whether to look up a community fact check on every article open, rather than
 *  only when the reader taps the button. Opt-in; see the field's comment. */
export const useAutoCommunityFactCheck = () =>
  useMeraProtocolStore((state) => state.autoCommunityFactCheck);

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
