// ============================================================
// Mera Protocol Toolkit — Public API Surface
// Protocol v2.0.0 | Toolkit v2.0.0
// ============================================================

// === Core Inference ===
export { infer, inferStream, decide } from './core/inference';

// === Base Model Lifecycle ===
export {
  downloadBaseModel,
  initBaseModel,
  disposeModel,
  resetContext,
  getModelState,
  isModelDownloaded,
  isTextModelResident,
  requiredModels,
  deleteBaseModel,
  deleteOnDeviceModels,
  purgeAllBaseModels,
  LocalModelsOffError,
} from './core/modelManager';

// === Model Catalogue ===
export {
  MODEL_CATALOG,
  TEXT_MODEL,
  RELEVANCE_MODEL,
  DEFAULT_MODEL_ID,
  RETIRED_MODEL_IDS,
  isRetiredModelId,
} from './core/model-catalog';
export type { ModelCatalogEntry, ModelRole } from './core/model-catalog';

// === Text engine (Qwen or the platform's own on-device model) ===
export {
  getTextEngine,
  setTextEngine,
  peekTextEngine,
  useTextEngine,
  nativeEngineAvailability,
  DEFAULT_TEXT_ENGINE,
} from './core/text-engine';
export type { TextEngine } from './core/text-engine';

// === Download Service ===
export {
  onDeviceModelsStatus,
  startModelDownloads,
  cancelModelDownload,
  isDownloadInProgress,
  restoreOnDeviceIfRunnable,
} from './core/downloadService';

// === Local mode rule (OnDevice only when On this phone can run) ===
export { localModeFor } from './core/retire-models';

// === System Requirements ===
export { checkRequirements } from './core/systemRequirements';

// === Types ===
export type {
  // Core
  Fact,
  InferParams,
  InferResult,
  BaseModelDownloadConfig,
  BaseModelManifest,
  ModelState,

  // System Requirements
  SystemRequirementsResult,
  RequirementCheckId,
} from './types';
