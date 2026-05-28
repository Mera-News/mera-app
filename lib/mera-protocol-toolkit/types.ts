// ============================================================
// Mera Protocol Toolkit — Type Definitions
// Source of truth: mera_protocol.md (Protocol v2.0.0)
// ============================================================

// --- User PII (on-device only, Rule #1) ---

export type Fact = {
  id: string; // UUID
  statement: string; // e.g., "I live in Berlin"
  metadata?: Record<string, string[]>; // App-defined derived fields
  questionnaireLevel?: number; // Questionnaire level number (1-10)
  questionnaireLevelCategory?: string; // e.g., "Core", "Professional"
  questionnaireAttribute?: string; // e.g., "location: neighborhood/area, city, and country"
  createdAt: string; // ISO timestamp
  updatedAt: string; // ISO timestamp
};

/**
 * Links a local fact to a server-side UserTopic.
 * Stored on-device only — the server never sees which facts generated which topics.
 */
export type FactTopicLink = {
  factId: string; // Local fact UUID
  serverTopicId: string; // Server-side UserTopic._id
  topicText: string; // The topic string sent to server
};

// --- Core Inference ---

export type InferParams = {
  prompt: string; // Full prompt string
  systemPrompt?: string; // Optional system-level instruction
  adapterId?: string; // LoRA adapter to use (hot-swapped, base model stays loaded)
  maxTokens?: number; // Max output tokens (default: 512)
  temperature?: number; // Sampling temperature (default: 0.3)
  stopSequences?: string[]; // Early termination strings
  responseFormat?: 'text' | 'json'; // Hint for structured output
  enableThinking?: boolean; // Enable Qwen3 thinking mode (default: false)
};

export type InferResult = {
  output: string; // Raw LLM output
  tokensUsed: number; // Total tokens consumed
  latencyMs: number; // Inference wall-clock time
  truncated: boolean; // Whether output hit maxTokens
};

// --- Model Lifecycle ---

export type BaseModelDownloadConfig = {
  modelId: string; // e.g., "mera-qwen3-4b"
  modelUrl: string; // URL to GGUF base model
  expectedChecksum: string; // SHA-256 of final artifact
  storageBudgetMB?: number; // Max local storage allowed
};

export type BaseModelManifest = {
  modelId: string;
  version: string;
  sizeBytes: number;
  quantization: string; // e.g., "Q4_K_M"
  downloadedAt: string; // ISO timestamp
  ready: boolean;
};

export type ModelState = {
  modelId: string;
  loaded: boolean;
  activeAdapterId: string | null; // Currently loaded adapter, if any
  contextWindow: number; // Max tokens
  memoryUsageMB: number;
  backend: string; // "metal" | "vulkan" | "cpu"
  inferenceSpeed: number; // Approximate tok/s
};

// --- Adapter Lifecycle ---

export type AdapterDownloadConfig = {
  adapterId: string; // e.g., "news-relevance", "news-topic-extraction"
  adapterUrl: string; // URL to LoRA adapter file
  targetBaseModelId: string; // Must match a downloaded base model
  expectedChecksum: string; // SHA-256 of adapter artifact
};

export type AdapterManifest = {
  adapterId: string;
  targetBaseModelId: string;
  version: string;
  sizeBytes: number;
  downloadedAt: string; // ISO timestamp
  ready: boolean;
};

// --- Privacy Layer ---

export type Query = {
  text: string; // Query string
  metadata?: Record<string, unknown>; // App-specific, stripped before transmission
};

export type NoiseConfig = {
  k: number; // Target k-anonymity (default: 1000)
  noiseRatio: number; // Noise queries per real query (default: 0.5-0.7)
  domainProfile: string; // App-provided distribution profile ID
};

export type NoisyQuerySet = {
  queryId: string; // Unique ID for this query cycle
  timestamp: string; // ISO timestamp
  queries: string[]; // Real + noise, shuffled, indistinguishable
};

// --- System Requirements ---

export type RequirementCheckId = 'ram' | 'os_version' | 'chip' | 'storage';

export type SystemRequirementsResult = {
  supported: boolean;
  reason: string; // Human-readable: failing reason or "All requirements met"
  failedCheck: RequirementCheckId | null; // Which check failed, or null if all passed
  deviceInfo: {
    ramGB: number | null;
    osVersion: string | null;
    platform: 'ios' | 'android' | 'unknown';
    modelId: string | null; // iOS only (e.g., "iPhone14,2")
    freeStorageGB: number | null;
  };
};
