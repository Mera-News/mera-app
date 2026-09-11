// reasoning-leak — strip a reasoning trace that a cloud model leaked INTO the
// answer instead of into `reasoning_content`.
//
// Friction this removes: with `enable_thinking:false`, GLM 5.3 Flash on NEAR
// still thinks and returns `trace</think>answer` as `content` (measured 2/2 on a
// short prompt, 0/52 on the shipped scoring prompts). The non-streaming SMALL
// path hands `content` straight to a JSON parser or, for reasons, to the UI, so
// a leak is either a parse failure or a user reading the model's thoughts.
// This is the same "prefill case" lib/llm/completeLocal.ts already handles for
// the on-device Qwen3 template, applied at the cloud decrypt sites.

/**
 * Return `text` without a leaked reasoning prefix. Well-formed
 * `<think>…</think>` blocks are removed; when only a closing `</think>` is
 * present (the template opened the block, the model closed it) everything up
 * to and including the LAST closer is dropped. Text without either is returned
 * unchanged — this is not a general sanitiser.
 */
export function stripLeakedReasoning(text: string): string {
  let stripped = text.replace(/<think>[\s\S]*?<\/think>/g, '');
  const lastCloser = stripped.lastIndexOf('</think>');
  if (lastCloser !== -1) {
    stripped = stripped.slice(lastCloser + '</think>'.length);
  }
  return stripped;
}
