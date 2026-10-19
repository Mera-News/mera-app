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

// === Download Service ===
export {
  startModelDownloads,
  cancelModelDownload,
  isDownloadInProgress,
} from './core/downloadService';

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
