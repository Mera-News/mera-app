// ============================================================
// Mera Protocol Toolkit — Public API Surface
// Protocol v2.0.0 | Toolkit v2.0.0
// ============================================================

// === Core Inference ===
export { infer, inferStream } from './core/inference';

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
} from './core/modelManager';

// === Adapter Lifecycle ===
export {
  downloadAdapter,
  loadAdapter,
  unloadAdapter,
  listAdapters,
  deleteAdapter,
} from './core/adapterManager';

// === Download Service ===
export {
  startModelDownload,
  cancelModelDownload,
  isDownloadInProgress,
} from './core/downloadService';

// === System Requirements ===
export { checkRequirements } from './core/systemRequirements';

// === Types ===
export type {
  // Core
  Fact,
  Query,
  InferParams,
  InferResult,
  BaseModelDownloadConfig,
  BaseModelManifest,
  ModelState,
  AdapterDownloadConfig,
  AdapterManifest,

  // Privacy
  NoisyQuerySet,
  NoiseConfig,

  // System Requirements
  SystemRequirementsResult,
  RequirementCheckId,
} from './types';
