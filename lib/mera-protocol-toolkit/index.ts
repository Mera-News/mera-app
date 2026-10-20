// ============================================================
// Mera Protocol Toolkit — Public API Surface
// Protocol v2.0.0 | Toolkit v2.0.0
// ============================================================

// === Core Inference ===
export {
  infer,
  inferStream,
  inferStructured,
  contextSize,
  decide,
  StructuredOutputError,
} from './core/inference';
export type { StructuredParams } from './core/inference';
export type { JsonSchema } from './core/structured-json';

// === Base Model Lifecycle ===
export {
  downloadBaseModel,
  initBaseModel,
  disposeModel,
  resetContext,
  getModelState,
  isModelDownloaded,
  deleteBaseModel,
  purgeAllBaseModels,
  LocalModelsOffError,
} from './core/modelManager';

// === Model Catalogue ===
export {
  MODEL_CATALOG,
  RELEVANCE_MODEL,
  DEFAULT_MODEL_ID,
  RETIRED_MODEL_IDS,
  isRetiredModelId,
} from './core/model-catalog';
export type { ModelCatalogEntry } from './core/model-catalog';

// === Text engine (the platform's built-in model: AFM or Gemini Nano) ===
export {
  getTextEngine,
  builtInEngine,
  builtInAvailability,
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
