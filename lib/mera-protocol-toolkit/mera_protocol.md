# The Mera Protocol

**Privacy-preserving personalization rules for AI applications.**

The Mera Protocol is a **set of rules and invariants** that any application must follow to guarantee user privacy while enabling personalization. It is not a library, framework, or runtime, it is a specification.

The `mera-protocol-toolkit/` folder contains a **compliance toolkit** (published as `mera-protocol-toolkit`): reference implementations of utilities that make it easier for React Native apps to satisfy the protocol's rules. Apps are free to use these tools, replace them with their own implementations, or mix and match, as long as the protocol invariants hold. The toolkit is React Native-specific due to its reliance on `llama.rn` for on-device inference, but the protocol itself is platform-agnostic.

---

## Overview

### The Protocol (rules)

The Mera Protocol defines **what must be true on the device** for an application to be privacy-preserving. The core constraint:

> **User PII never leaves the device. Any data transmitted externally is noisy and k-anonymous. All final inference and decision-making happen on-device.**
> 

The protocol's guarantees are **unconditional**: they hold regardless of what any external system does. The protocol makes no assumptions about servers, APIs, or infrastructure. If the on-device rules are satisfied, privacy is guaranteed even if every external system is fully adversarial.

**The protocol specifies:**

- What data can and cannot leave the device
- How outbound data must be anonymized before any external transmission
- Privacy equivalence requirements between on-device and Confidential VM paths
- The trust model and its boundaries

### The Compliance Toolkit (code)

The `mera-protocol-toolkit/` folder ships utilities that help apps satisfy the protocol rules:

- On-device LLM lifecycle (`infer`, `inferStream`, shared base model, adapter hot-swapping)
- Privacy-preserving query exchange (`injectNoise`, `stripNoise`)
- Local-only user PII storage (CRUD)

Apps compose these tools to build domain-specific workflows. The toolkit does **not** provide:

- Domain-specific scoring, ranking, or selection logic
- Domain-specific prompts or output formatting
- Application UI or presentation logic

These are the responsibility of the consuming application (e.g., `mera-news`, `mera-mental-health`).

---

## Protocol Rules

These are **hard rules** that define the Mera Protocol. Any code path that violates them is a protocol breach. An app is "Mera Protocol compliant" if and only if all of these hold at all times.

| # | Rule | Enforcement |
| --- | --- | --- |
| 1 | **Facts never leave the device.** **User PII stored in the on-device database must not be transmitted, logged, or serialized to any external destination.** | User PII DB is `LocalOnly` — no network access, no sync |
| 2 | **All outbound data is noisy.** Real queries must be mixed with noise before any external transmission. No raw user-derived query may leave the device. | `injectNoise()` is the sole gateway to any transmittable data |
| 3 | **Real and noise are structurally indistinguishable.** Query format, length, and structure must be uniform across real and noise entries. | Noise generator mirrors real query structure |
| 4 | **No consumption signals leave the device.** Final selection, ranking, and presentation happen on-device. No read receipts, open events, or selection signals are transmitted externally. | On-device only: app-level selection logic |
| 5 | **K-anonymity holds.** Each outbound query set must be indistinguishable from at least K other users' query sets (K ≥ 1000). | Noise patterns drawn from common user distributions |
| 6 | **All inference over user PII is on-device.** Any computation that takes user PII as input must run within the device trust boundary (or an attested Confidential VM that the protocol treats as equivalent). | On-device LLM or attested CVM; no cloud inference over plaintext facts |

---

## Data Flow (Generalized)

```
┌─────────────────────────────────────────────────────────────────┐
│ DEVICE (trust boundary — protocol governs everything here)      │
│                                                                 │
│  User ──→ Facts DB (LOCAL ONLY)                                 │
│                  │                                              │
│                  ▼                                              │
│          infer(generateQueriesPrompt) ──→ Queries               │
│                                              │                  │
│                                              ▼                  │
│                                       injectNoise()             │
│                                              │                  │
│                                              ▼                  │
│                                       NoisyQuerySet ────────────┼──→ (external)
│                                                                 │
│  ◄── Candidate Items ──────────────────────────────────────────┼──── (external)
│         │                                                       │
│         ▼                                                       │
│  stripNoise() ──→ filterByOriginalQueries()                     │
│                          │                                      │
│                          ▼                                      │
│              ┌───────────────────────┐                          │
│              │  APP-SPECIFIC LOGIC   │                          │
│              │  (uses toolkit.infer  │                          │
│              │   for LLM calls)      │                          │
│              └───────────────────────┘                          │
│                          │                                      │
│                          ▼                                      │
│                   App-specific output                           │
└─────────────────────────────────────────────────────────────────┘
```

The protocol governs **everything inside the trust boundary**. What happens outside (servers, APIs, third-party services) is irrelevant. The protocol's guarantees hold unconditionally. The compliance toolkit provides ready-made implementations of these steps.

---

## User PII Database (On-Device)

In the Mera Protocol, **user PII** (personally identifiable information) refers to any data that describes the user: who they are, what they care about, where they are, and how they feel. The protocol mandates that all user PII is **stored exclusively on-device** and never transmitted to any external system.

User PII can be **user-authored** (the user writes it directly) or **LLM-derived** (generated by on-device inference from user input, behavior, or other PII). Both are treated identically by the protocol: they are stored in the local on-device database and never leave the device.

```tsx
type Fact = {
  id: string              // UUID
  statement: string       // "I live in Berlin"
  metadata?: Record<string, string[]>  // App-defined derived fields
  createdAt: string       // ISO timestamp
  updatedAt: string       // ISO timestamp
}
```

**Rules:**

- User PII is plain text, either entered directly by the user (e.g., *"I live in Berlin"*, *"I work at Meta"*) or derived by on-device LLM inference (e.g., *"User prefers long-form investigative journalism"*, *"User shows interest in climate policy"*)
- The `metadata` field allows apps to derive and cache structured data at write time (e.g., locations, entities, symptoms), this is app-specific, not protocol-defined
- User PII DB is stored locally (WatermelonDB / SQLite) with no sync, no backup to server
- User has full CRUD control: add, edit, delete PII at any time
- PII changes can trigger app-defined recomputation (e.g., regenerating queries)

**Privacy:** The user PII database is the most sensitive data in the system. It must never be accessible to any network call, analytics SDK, or crash reporter. Any data derived from user PII (e.g., queries, prompts, inference results) inherits the same local-only constraint until it has been anonymized through the noise injection layer.

---

## Compliance Toolkit API

The following modules are **tools provided in the `mera-protocol-toolkit/` folder** to help apps achieve protocol compliance. They are not the protocol itself — they are reference implementations. An app may use all, some, or none of these, as long as the protocol rules are satisfied.

### Core Inference

### `infer(params: InferParams): Promise<InferResult>`

General-purpose on-device LLM inference. This is the **primary computation tool** in the toolkit. Apps call this for any task requiring LLM reasoning over local data.

- **Input:** A prompt string (or structured prompt), generation config, and optional context
- **Output:** Raw LLM output (text) with token usage metadata
- **Privacy:** All inference runs within the device trust boundary. Prompt content (which may include user PII) never leaves it.

```tsx
type InferParams = {
  prompt: string               // Full prompt string
  systemPrompt?: string        // Optional system-level instruction
  adapterId?: string           // LoRA adapter to use (hot-swapped, base model stays loaded)
  maxTokens?: number           // Max output tokens (default: 512)
  temperature?: number         // Sampling temperature (default: 0.3)
  stopSequences?: string[]     // Early termination strings
  responseFormat?: 'text' | 'json'  // Hint for structured output
}

type InferResult = {
  output: string               // Raw LLM output
  tokensUsed: number           // Total tokens consumed
  latencyMs: number            // Inference wall-clock time
  truncated: boolean           // Whether output hit maxTokens
}
```

**Usage examples across apps:**

| App | Call | Purpose |  |
| --- | --- | --- | --- |
| mera-news | `infer({ prompt: scoreRelevancePrompt(facts, articles), adapterId: 'news-relevance' })` | Score articles against user profile |  |
| mera-mental-health | `infer({ prompt: assessMoodPrompt(facts, journalEntry), adapterId: 'mh-mood' })` | Assess mood patterns from journal entries |  |
| mera-finance | `infer({ prompt: classifyTransactionPrompt(facts, txns), adapterId: 'fin-classify' })` | Classify transactions by personal categories |  |

### `inferStream(params: InferParams): AsyncGenerator<string>`

Streaming variant of `infer()`. Yields tokens as they are generated. Useful for apps that display progressive output.

```tsx
// Example: streaming a response in a mental health journaling app
for await (const token of inferStream({ prompt, maxTokens: 256 })) {
  appendToUI(token)
}
```

---

### Model Lifecycle

The toolkit separates **base model** management from **adapter** management. The base model is downloaded once and shared across all apps. Adapters are lightweight, app-specific, and hot-swappable without reloading the base model.

### Base Model

### `downloadBaseModel(config: BaseModelDownloadConfig): Promise<BaseModelManifest>`

Downloads and stores the shared base model for on-device inference.

- **Input:** Model identifier, source URL, and storage preferences
- **Output:** Manifest describing the downloaded model
- **Rules:**
    - The base model is stored in a shared location accessible to all Mera Protocol apps (iOS: App Group container, Android: shared ContentProvider)
    - Download supports resumption on network interruption
    - Integrity is verified via SHA-256 checksum before marking as ready
    - Only one base model version is active at a time

```tsx
type BaseModelDownloadConfig = {
  modelId: string              // e.g., "mera-qwen3-4b"
  modelUrl: string             // URL to GGUF base model
  expectedChecksum: string     // SHA-256 of final artifact
  storageBudgetMB?: number     // Max local storage allowed
}

type BaseModelManifest = {
  modelId: string
  version: string
  sizeBytes: number
  quantization: string         // e.g., "Q4_K_M"
  downloadedAt: string         // ISO timestamp
  ready: boolean
}
```

### `initBaseModel(modelId?: string): Promise<ModelState>`

Loads the shared base model into memory, ready for inference.

- **Input:** Model identifier (defaults to the primary downloaded base model)
- **Output:** Model state including capabilities and memory footprint
- **Rules:**
    - Only one base model can be loaded at a time
    - The base model stays loaded across adapter swaps
    - Calling `initBaseModel` while a model is loaded will dispose the previous one first

```tsx
type ModelState = {
  modelId: string
  loaded: boolean
  activeAdapterId: string | null  // Currently loaded adapter, if any
  contextWindow: number        // Max tokens
  memoryUsageMB: number
  backend: string              // "metal" | "vulkan" | "cpu"
  inferenceSpeed: number       // Approximate tok/s
}
```

### `disposeModel(): Promise<void>`

Unloads the base model and any active adapter from memory. Frees all associated resources.

### `getModelState(): ModelState | null`

Returns the current model state (including active adapter), or `null` if no model is loaded.

### Adapters

### `downloadAdapter(config: AdapterDownloadConfig): Promise<AdapterManifest>`

Downloads a LoRA adapter for use with the shared base model.

- **Input:** Adapter identifier, source URL, and target base model
- **Output:** Manifest describing the downloaded adapter
- **Rules:**
    - Adapters are stored in the app's local sandboxed storage (not shared across apps)
    - Each adapter is validated against its target base model at download time
    - Multiple adapters can be stored on disk simultaneously

```tsx
type AdapterDownloadConfig = {
  adapterId: string            // e.g., "news-relevance", "news-topic-extraction"
  adapterUrl: string           // URL to LoRA adapter file
  targetBaseModelId: string    // Must match a downloaded base model
  expectedChecksum: string     // SHA-256 of adapter artifact
}

type AdapterManifest = {
  adapterId: string
  targetBaseModelId: string
  version: string
  sizeBytes: number
  downloadedAt: string         // ISO timestamp
  ready: boolean
}
```

### `loadAdapter(adapterId: string): Promise<void>`

Hot-swaps the active LoRA adapter on the loaded base model.

- **Rules:**
    - Base model must already be loaded via `initBaseModel()`
    - Swapping adapters does **not** reload the base model (swap time: ~50-200ms)
    - Only one adapter can be active at a time
    - Passing a different `adapterId` automatically unloads the previous adapter

### `unloadAdapter(): Promise<void>`

Removes the active adapter, reverting to the bare base model.

### `listAdapters(): AdapterManifest[]`

Returns all downloaded adapters available on-device for the current app.

### `deleteAdapter(adapterId: string): Promise<void>`

Deletes a downloaded adapter from local storage.

### `deleteBaseModel(modelId: string): Promise<void>`

Deletes the shared base model from storage. Only succeeds if no app currently has it loaded.

---

### Privacy Layer (Noise Injection & Stripping)

### `injectNoise(queries: Query[], config?: NoiseConfig): NoisyQuerySet`

Adds noise queries to achieve k-anonymity before any external transmission. This tool enforces **Protocol Rule #2** (all outbound data is noisy). It is application-agnostic. It works with any query structure as long as queries conform to the `Query` type.

- **Input:** Real queries generated by the app (on-device only)
- **Output:** Combined set where real and noise queries are structurally indistinguishable
- **Protocol enforcement:** This is the **sole gateway** to externally transmittable data. Using this tool satisfies Rules #2, #3, and #5.
- **Rules:**
    - Noise queries must match the format and string structure of real queries
    - Noise must match common distribution patterns for the app's domain (not random)
    - The noise distribution profile is provided by the app via `NoiseConfig.domainProfile`

```tsx
type Query = {
  text: string                 // Query string
  metadata?: Record<string, unknown>  // App-specific, stripped before transmission
}

type NoiseConfig = {
  k: number                    // Target k-anonymity (default: 1000)
  noiseRatio: number           // Noise queries per real query (default: 0.5-0.7)
  domainProfile: string        // App-provided distribution profile ID
}

type NoisyQuerySet = {
  queryId: string              // Unique ID for this query cycle
  timestamp: string            // ISO timestamp
  queries: string[]            // Real + noise, shuffled, indistinguishable
}
```

### `stripNoise<T>(items: T[], originalQueries: Query[], matchFn: (item: T, query: Query) => boolean): T[]`

Filters externally returned items to keep only those matching original (non-noise) queries.

- **Input:** Externally returned candidate items + original queries + app-provided matching function
- **Output:** Items matching real queries only
- **Runs:** On-device, every pull cycle
- **Generic:** Works with any item type: articles, resources, entries, etc.

---

### User PII CRUD

```tsx
export function addFact(statement: string, metadata?: Record<string, string[]>): Promise<Fact>
export function updateFact(id: string, updates: Partial<Pick<Fact, 'statement' | 'metadata'>>): Promise<Fact>
export function deleteFact(id: string): Promise<void>
export function getFacts(): Promise<Fact[]>
```

All operations are local-only. No network calls, no sync.

---

## On-Device LLM

| Property | Value |
| --- | --- |
| Default base model | Qwen3 4B (4-bit quantized, ~2GB) |
| Adapter support | LoRA adapters (~20-50MB each) |
| Runtime | llama.cpp via llama.rn |
| Backend | Metal (iOS) / Vulkan (Android) |
| Context window | 2048 tokens (configurable) |
| Inference speed | 25-40 tok/s (iOS), 20-30 tok/s (Android) |

The toolkit owns the LLM lifecycle. Apps that use these tools never need to interact with `llama.cpp` directly; they call `infer()` and `inferStream()`. Apps that bring their own on-device inference runtime can skip these tools entirely, as long as Protocol Rule #6 is satisfied (all inference over personal data stays within the trust boundary).

**Shared base model:** The base model (~2GB) is downloaded once and stored in a shared location on the device. All Mera Protocol apps use the same base model, so the user never downloads it twice.

**Adapter hot-swapping:** Apps ship lightweight LoRA adapters (~20-50MB each) that are hot-swapped on top of the loaded base model. Swapping an adapter does not reload the base model, so transitions take ~50-200ms. Apps can have multiple adapters for different tasks:

- `mera-news` ships adapters for user elicitation, topic extraction, and relevance classification
- `mera-mental-health` ships adapters for mood assessment and symptom recognition

**Memory budget:** ~2GB (base) + ~50MB (one active adapter) = ~2.05GB at inference time, regardless of how many adapters are installed on disk.

**Adapter selection:** Apps pass `adapterId` in `InferParams` to specify which adapter to use for each inference call. The toolkit handles loading and swapping transparently. If no `adapterId` is provided, inference runs on the bare base model.

---

## Confidential VM Fallback

For devices that cannot run on-device inference, the protocol provides an equivalent path via a Confidential VM (Google Confidential Space, AMD SEV-SNP).

**Key properties:**

- **Protocol symmetry.** External systems see identical traffic from both paths. They cannot determine which path a device uses.
- **Zero trust coupling.** The Confidential VM never communicates with the app's backend.
- **Two-key encryption.** User key (PIN-derived, Argon2id) + system key (released only to attested VMs). Neither party alone can decrypt.
- **Stateless.** VM decrypts → computes → returns → wipes. No persistence.
- **App-agnostic.** The Confidential VM runs a protocol-compliant runtime. The app's inference calls are routed transparently — the app does not know (or need to know) whether inference ran locally or in the enclave.

**Privacy equivalence:**

| Guarantee | On-Device | Confidential VM |
| --- | --- | --- |
| Profile invisible to app operator | ✅ Mathematical | ✅ TEE isolation |
| Profile invisible to third party | ✅ | ✅ Hardware attestation |
| External systems see identical traffic | ✅ | ✅ Protocol symmetry |
| Trust model | Zero trust | Trust in hardware TEE |

---

## Why No Server Rules?

The Mera Protocol intentionally says nothing about what servers, APIs, or external systems should or should not do. The protocol's on-device guarantees are **unconditional**:

- The server *cannot* see user PII, because it never leaves the device (Rule #1).
- The server *cannot* distinguish real queries from noise, because they are structurally identical (Rule #3).
- The server *cannot* know what the user consumed, because no consumption signals are transmitted (Rule #4).
- The server *cannot* reconstruct the user's profile, because k-anonymity makes any individual indistinguishable from ≥1000 others (Rule #5).

If the on-device rules hold, privacy holds — even if the server is fully adversarial, compromised, or logging everything. This is the protocol's core strength: **it does not require trust in any external system.**

---

## Directory Structure (Compliance Toolkit)

```jsx
src/mera-protocol-toolkit/
├── PROTOCOL.md              # This file — the protocol rules
├── index.ts                 # Toolkit API surface (sole export point)
├── types.ts                 # Shared types: Fact, Query, NoisyQuerySet, InferParams, etc.
│
├── core/                    # Tools for on-device computation
│   ├── inference.ts         # infer(), inferStream() — LLM orchestration
│   ├── modelManager.ts      # downloadBaseModel(), initBaseModel(), disposeModel(), etc.
│   └── adapterManager.ts    # downloadAdapter(), loadAdapter(), unloadAdapter(), etc.
│
├── privacy/                 # Tools for protocol-compliant data exchange
│   ├── noiseInjector.ts     # injectNoise() — enforces Rules #2, #3, #5
│   └── noiseStrip.ts        # stripNoise() — client-side noise removal
│
├── storage/                 # Tools for local-only data persistence
│   └── factsDb.ts           # On-device user PII database (CRUD) — enforces Rule #1
│
└── utils/
    └── crypto.ts            # Key derivation, encryption helpers for CVM path
```

---

## Toolkit Exports (`index.ts`)

The package exports only these tools. Internal modules are not accessible.

```tsx
// === Core Inference ===
export { infer, inferStream } from './core/inference'

// === Base Model Lifecycle ===
export {
  downloadBaseModel,
  initBaseModel,
  disposeModel,
  getModelState,
  deleteBaseModel,
} from './core/modelManager'
// === Adapter Lifecycle ===
export {
  downloadAdapter,
  loadAdapter,
  unloadAdapter,
  listAdapters,
  deleteAdapter,
} from './core/adapterManager'

// === Privacy Layer ===
export { injectNoise } from './privacy/noiseInjector'
export { stripNoise } from './privacy/noiseStrip'

// === User PII (on-device database, local-only) ===
export { addFact, updateFact, deleteFact, getFacts } from './storage/factService'

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
} from './types'
```

---

## App Integration Pattern

Apps achieve protocol compliance by following the rules and (optionally) using the toolkit. The toolkit never imports from an app; the dependency is strictly one-way.

```jsx
┌──────────────────────────────────────────────────────┐
│             mera-news (app)                          │
│                                                      │
│  scoreRelevance()      ← calls toolkit.infer()       │
│  generateTopics()      ← calls toolkit.infer()       │
│  detectNovelty()       ← app-local logic             │
│  selectNotifications() ← app-local logic             │
│  prompts/              ← news-specific prompts       │
└──────────────────┬───────────────────────────────────┘
                   │ imports
┌──────────────────▼───────────────────────────────────┐
│     mera-protocol-toolkit/ (rules + compliance toolkit)      │
│                                                      │
│  PROTOCOL.md  ← the rules (this file)                │
│  infer()        inferStream()    ← toolkit tools     │
│  initBaseModel() loadAdapter()   ← toolkit tools     │
│  injectNoise()  stripNoise()     ← toolkit tools     │
│  getFacts()                      ← toolkit tools     │
└──────────────────────────────────────────────────────┘
```

**Example: mera-news using the toolkit for protocol compliance**

```tsx
import {
  infer, injectNoise, stripNoise,
  getFacts, initBaseModel, downloadAdapter
} from 'mera-protocol-toolkit'

// App-specific: generate topics from facts
async function generateTopics(facts: Fact[]): Promise<Query[]> {
  const result = await infer({
    prompt: buildTopicPrompt(facts),    // news-specific prompt
    adapterId: 'news-topic-extraction', // hot-swapped, base model stays loaded
    responseFormat: 'json',
    maxTokens: 1024,
  })
  const topics = JSON.parse(result.output)
  return topics
}

// App-specific: score relevance
async function scoreRelevance(facts: Fact[], articles: Article[]) {
  const result = await infer({
    prompt: buildScorePrompt(facts, articles),  // news-specific prompt
    adapterId: 'news-relevance',                // different adapter, same base model
    responseFormat: 'json',
  })
  return JSON.parse(result.output)
}
```

**Example: mera-mental-health using the same toolkit**

```tsx
import { infer, getFacts, injectNoise, stripNoise } from 'mera-protocol-toolkit'

// App-specific: assess mood from journal + facts
async function assessMood(facts: Fact[], journalEntry: string) {
  const result = await infer({
    prompt: buildMoodPrompt(facts, journalEntry),  // mental-health prompt
    adapterId: 'mh-mood',                          // mental-health adapter
    responseFormat: 'json',
  })
  return JSON.parse(result.output)
}

// App-specific: generate wellness queries for resource matching
async function generateWellnessQueries(facts: Fact[]) {
  const result = await infer({
    prompt: buildWellnessQueryPrompt(facts),
    adapterId: 'mh-wellness-queries',
    responseFormat: 'json',
    maxTokens: 512,
  })
  return JSON.parse(result.output)
}
```

---

## Versioning

**Protocol** and **toolkit** are versioned independently.

**Protocol version** (semver):

- **Major:** Breaking change to privacy rules or trust model
- **Minor:** New rule, new privacy guarantee, expanded trust model
- **Patch:** Clarification, wording fix

**Toolkit version** (semver):

- **Major:** Breaking change to toolkit API signatures
- **Minor:** New tool, new model backend, additional noise strategy
- **Patch:** Bug fix, performance optimization

Current protocol version: **2.0.0**

Current toolkit version: **2.0.0**

---

## License

The Mera Protocol specification and the compliance toolkit are open source.

See `LICENSE` for details.