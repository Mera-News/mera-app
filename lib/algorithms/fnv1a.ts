/** FNV-1a 32-bit over UTF-16 code units. Deterministic across launches and platforms.
 *  Stored keys (translation cache ids, fact colours, fingerprints) depend on this output. */
export function fnv1a32(input: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}
