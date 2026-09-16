// harness-local — model facts and per-call cost, taken from the LIVE catalogue.
//
// WHY THIS IS NOT A HARDCODED TABLE. Prices move and models retire, and a
// stale constant does neither loudly. The 2026-09-16 roster review found
// `deepseek-ai/DeepSeek-V4-Flash` carrying `deprecation_date`
// 2026-09-17T13:00:00Z, one day out, which no committed table would have said.
// Fetching the catalogue at run start and CACHING IT INTO THE RUN DIR makes a
// run self-describing: the prices and the retirement dates it was costed
// against travel with it, so an old report can never silently be re-read at
// today's prices.
//
// Node-only. Imports nothing from expo/react-native.

import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** Chat persona prompts. Tool calling with schema-conformant arguments is the
 *  requirement, so the roster here is not interchangeable with the one below. */
export const CHAT_ARM_MODELS = ['Qwen/Qwen3.8-27B'] as const;

/** Harness scoring, reasons and topic generation. JSON-shaped prompts, thinking
 *  off, never function tools. Qwen3.6 is the control (what ships today as
 *  SMALL_MODEL); GLM 5.3 Flash is the cheaper candidate at 0.5 against 1.1 per
 *  million output, which is the axis that decides this path. */
export const HARNESS_ARM_MODELS = ['Qwen/Qwen3.6-35B-A3B-FP8', 'z-ai/glm-5.3-flash'] as const;

export interface ModelPricing {
  /** USD per million tokens. */
  inputPerM: number;
  outputPerM: number;
  cachedInputPerM: number;
}

export interface ModelInfo {
  id: string;
  name: string;
  ownedBy: string;
  isReady: boolean;
  /** ISO timestamp, or null. Present means the model retires, and a run inside
   *  the window gets a warning line in its summary. */
  deprecationDate: string | null;
  pricing: ModelPricing;
  supportedFeatures: string[];
  maxOutputLength: number | null;
  /** `owned_by === 'nearai'` is the self-hosted TEE tier, the only one whose
   *  attestation report carries `model_attestations[0].signing_public_key` and
   *  therefore the only one the E2EE gateway lane can serve. Anything else is
   *  direct-NEAR only. See lib/llm/constants.ts:13-23. */
  selfHosted: boolean;
}

export type ModelCatalog = Record<string, ModelInfo>;

interface RawModel {
  id?: string;
  name?: string;
  owned_by?: string;
  is_ready?: boolean;
  deprecation_date?: string;
  max_output_length?: number;
  supported_features?: string[];
  pricing?: {
    input?: number | string;
    output?: number | string;
    prompt?: number | string;
    completion?: number | string;
    input_cache_read?: number | string;
  };
}

function num(v: unknown): number | null {
  const n = typeof v === 'string' ? Number(v) : typeof v === 'number' ? v : NaN;
  return Number.isFinite(n) ? n : null;
}

/**
 * The catalogue reports `input`/`output` per MILLION tokens but
 * `prompt`/`completion`/`input_cache_read` per SINGLE token. Mixing the two
 * silently produces a cost off by 1e6, so every field is normalised to
 * per-million here and nowhere else.
 */
function normalisePricing(raw: RawModel['pricing']): ModelPricing {
  const inputPerM = num(raw?.input) ?? (num(raw?.prompt) ?? 0) * 1e6;
  const outputPerM = num(raw?.output) ?? (num(raw?.completion) ?? 0) * 1e6;
  const cachedInputPerM = (num(raw?.input_cache_read) ?? 0) * 1e6;
  return { inputPerM, outputPerM, cachedInputPerM };
}

/**
 * Fetches and normalises the catalogue. `runDir` writes `models.json` beside
 * the run's rows so the run carries its own price list.
 */
export async function fetchModelCatalog(opts: {
  baseUrl: string;
  apiKey: string;
  runDir?: string;
}): Promise<ModelCatalog> {
  const res = await fetch(`${opts.baseUrl}/models`, {
    headers: { Authorization: `Bearer ${opts.apiKey}` },
  });
  if (!res.ok) {
    throw new Error(
      `harness-local: model catalogue fetch failed: ${res.status} ${res.statusText}. ` +
        'Cost cannot be computed without it, and a run that cannot price itself is not worth starting.',
    );
  }
  const body = (await res.json()) as { data?: RawModel[] };
  const rows = body.data ?? [];
  if (rows.length === 0) {
    throw new Error('harness-local: model catalogue came back empty.');
  }

  const catalog: ModelCatalog = {};
  for (const raw of rows) {
    if (!raw.id) continue;
    catalog[raw.id] = {
      id: raw.id,
      name: raw.name ?? raw.id,
      ownedBy: raw.owned_by ?? 'unknown',
      isReady: raw.is_ready !== false,
      deprecationDate: raw.deprecation_date ?? null,
      pricing: normalisePricing(raw.pricing),
      supportedFeatures: raw.supported_features ?? [],
      maxOutputLength: raw.max_output_length ?? null,
      selfHosted: raw.owned_by === 'nearai',
    };
  }

  if (opts.runDir) {
    writeFileSync(
      join(opts.runDir, 'models.json'),
      `${JSON.stringify({ fetchedAt: new Date().toISOString(), baseUrl: opts.baseUrl, catalog }, null, 2)}\n`,
      'utf8',
    );
  }
  return catalog;
}

export interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
  cachedTokens: number;
}

/**
 * USD for one call. Cached prompt tokens are billed at the cache-read rate and
 * SUBTRACTED from the full-rate prompt tokens, which is how the catalogue's own
 * two prices are meant to combine. A negative remainder (a provider reporting
 * more cached than prompt tokens) clamps at zero rather than crediting a run.
 */
export function costOf(info: ModelInfo, usage: TokenUsage): number {
  const cached = Math.max(0, Math.min(usage.cachedTokens, usage.promptTokens));
  const uncached = Math.max(0, usage.promptTokens - cached);
  return (
    (uncached * info.pricing.inputPerM) / 1e6 +
    (cached * info.pricing.cachedInputPerM) / 1e6 +
    (usage.completionTokens * info.pricing.outputPerM) / 1e6
  );
}

/**
 * One line per problem, for the summary header. Silence is a real result here:
 * it means every arm was ready, priced and not retiring.
 */
export function rosterWarnings(
  catalog: ModelCatalog,
  modelIds: readonly string[],
  opts: { now?: Date; horizonDays?: number } = {},
): string[] {
  const now = opts.now ?? new Date();
  const horizonMs = (opts.horizonDays ?? 30) * 24 * 60 * 60 * 1000;
  const out: string[] = [];
  for (const id of modelIds) {
    const info = catalog[id];
    if (!info) {
      out.push(`MISSING: ${id} is not in the NEAR catalogue. Check the id against /v1/models.`);
      continue;
    }
    if (!info.isReady) out.push(`NOT READY: ${id} reports is_ready false.`);
    if (info.pricing.inputPerM === 0 && info.pricing.outputPerM === 0) {
      out.push(`NO PRICE: ${id} priced at zero, so its cost column is meaningless.`);
    }
    if (info.deprecationDate) {
      const when = Date.parse(info.deprecationDate);
      const days = Math.round((when - now.getTime()) / (24 * 60 * 60 * 1000));
      if (Number.isFinite(when) && when - now.getTime() < horizonMs) {
        out.push(
          when <= now.getTime()
            ? `RETIRED: ${id} retired ${info.deprecationDate}. Results from it are historical.`
            : `RETIRING: ${id} retires ${info.deprecationDate}, in ${days} day(s). An arm on it expires before anyone can act on it.`,
        );
      }
    }
  }
  return out;
}
