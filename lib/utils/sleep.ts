/** A plain timer wait; it does not observe an AbortSignal. A leaf module (no imports) on purpose:
 *  importing it must never pull anything into an import cycle (scripts/codemods/cycles.ts). */
export function sleep(ms: number): Promise<void> {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}
