// The harness registry loader: reads every folder's harness.json and resolves `extends` chains.
// Static imports, because Metro cannot read a directory at runtime. A new folder is one line here
// and one mapping.json entry; the guard test fails if either is missing.
import type { Harness, HarnessFile, HarnessParams } from './types';
import mapping from './mapping.json';
import cloudBase from './cloud-base/harness.json';
import deviceBase from './device-base/harness.json';
import qwen38 from './qwen3.8-27b/harness.json';
import qwen36 from './qwen3.6-35b-a3b/harness.json';
import afm from './afm/harness.json';

export const HARNESS_FILES: Record<string, HarnessFile> = {
  'cloud-base': cloudBase as HarnessFile,
  'device-base': deviceBase as HarnessFile,
  'qwen3.8-27b': qwen38 as HarnessFile,
  'qwen3.6-35b-a3b': qwen36 as HarnessFile,
  afm: afm as HarnessFile,
};

/** `<provider>:<provider model id>` -> harness folder. */
export const HARNESS_MAPPING: Record<string, string> = mapping;

const resolved = new Map<string, Harness>();

/** The harness in `folder` with its whole `extends` chain applied. Throws on an unknown folder or a cycle. */
export function loadHarness(folder: string): Harness {
  const hit = resolved.get(folder);
  if (hit) return hit;
  const chain: string[] = [];
  for (let at: string | null = folder; at !== null; at = HARNESS_FILES[at].extends) {
    if (!HARNESS_FILES[at]) throw new Error(`harness "${at}" not found (from "${folder}")`);
    if (chain.includes(at)) throw new Error(`harness extends cycle: ${[...chain, at].join(' -> ')}`);
    chain.unshift(at);
  }
  const files = chain.map((f) => HARNESS_FILES[f]);
  // Per-lane maps merge key by key; every other param is replaced whole by the later file.
  const params = files.reduce<Partial<HarnessParams>>((acc, f) => ({
    ...acc,
    ...f.params,
    maxTokens: { ...acc.maxTokens, ...f.params.maxTokens },
    firstTokenDeadlineMs: { ...acc.firstTokenDeadlineMs, ...f.params.firstTokenDeadlineMs },
  }), {}) as HarnessParams;
  const harness: Harness = {
    folder,
    chain,
    params,
    lanes: files.reduce<Harness['lanes']>((acc, f) => f.lanes ?? acc, []),
    slots: files.reduce<Record<string, string>>((acc, f) => ({ ...acc, ...f.slots }), {}),
  };
  resolved.set(folder, harness);
  return harness;
}

/** The harness folder for one provider's model id, or null when no folder is mapped. */
export function harnessFolderFor(provider: string, model: string): string | null {
  return HARNESS_MAPPING[`${provider}:${model}`] ?? null;
}
