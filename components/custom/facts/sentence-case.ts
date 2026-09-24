// Sentence case for text a person or a model wrote: the first letter up,
// everything else exactly as written.
//
// This replaces the `capitalize` class. On iOS that maps to NSString
// `capitalizedString`, which uppercases every word AND LOWERCASES THE REST of
// it, so "privacy-preserving AI" rendered as "Privacy-Preserving Ai" and
// "(DMA)" as "(Dma)". Only the first letter is ours to touch; acronyms, brand
// casing and "5G" are the writer's.

/** Uppercases the first letter (skipping leading quotes, spaces or digits). */
export function sentenceCase(text: string): string {
  const i = text.search(/\p{L}/u);
  if (i < 0) return text;
  const ch = text[i];
  const upper = ch.toLocaleUpperCase();
  return upper === ch ? text : text.slice(0, i) + upper + text.slice(i + 1);
}
