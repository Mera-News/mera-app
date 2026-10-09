// Chat-area test helpers. Shared harness helpers come from '@/test/helpers'; these are the
// chat-specific ones (module resets, seeding, scripted replies, on-device fakes).
export { resetChatModules } from './reset';
export { seedFacts, setProcessingMode, setWebSearchInChat, type SeedFact } from './persona';
export { toolCall, reply, systemOf, personMessage, isRouteLeg, toolResultsIn, hasToolResult } from './replies';
export { installLlama, llamaCalls, llamaReleases, type LlamaCall, type LlamaScript } from './llama';
export { fileSystemModule, resetFileSystem, placeModelFile } from './fs';
export { useStrictClock } from './clock';

/** Polls `cond` on real macrotasks until it holds (or throws after `ms`). Under the fake clock
 *  use advanceUntilDone from '@/test/helpers' instead. */
export async function until(cond: () => boolean, ms = 5000, label = 'condition'): Promise<void> {
  for (let t = 0; t < ms && !cond(); t += 10) await new Promise((r) => setTimeout(r, 10));
  if (!cond()) throw new Error(`until: ${label} not met within ${ms}ms`);
}
