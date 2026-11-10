// A harness is everything a model needs beyond its id: wire params and the prompt slots.
// One folder per model (an implementation) extends one base (cloud-base, device-base) and holds
// only what differs. mapping.json at the root names the folder for each `<provider>:<model id>`.
// The slots are the folder's .md files, not part of harness.json (slots.ts, generate.ts).
import type { Lane } from '../llm/router/lanes';

export interface HarnessParams {
  /** The text-tool wire format the prompts are written for (cloud: lib/llm/text-tool-protocol). */
  toolFormat: string;
  /** False forces a chat turn's `enable_thinking` off whatever the caller asks; true leaves the caller's choice.
   *  Chat only, as the old session-fallback rule was: batch and job callers keep their own flag. */
  thinking: boolean;
  /** The output budget per lane this harness is qualified for.
   *  shortcut: documented, not enforced; callers keep their own budgets until a non-Qwen harness needs a cap. */
  maxTokens: Partial<Record<Lane, number>>;
  /** No first token (a buffered call: no answer) within this long is a model failure. */
  firstTokenDeadlineMs: Partial<Record<Lane, number>>;
  /** Names of request transforms in quirks.ts, applied in order. */
  quirks: string[];
}

/** One harness.json as written: an implementation sets only what it overrides. */
export interface HarnessFile {
  extends: string | null;
  params: Partial<HarnessParams>;
  lanes?: Lane[];
}

/** A harness with its `extends` chain applied, base first and overrides last. */
export interface Harness {
  folder: string;
  /** The chain, base first: ['cloud-base', 'qwen3.8-27b']. */
  chain: string[];
  params: HarnessParams;
  lanes: Lane[];
}
