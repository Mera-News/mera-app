// The matched facts as one line for the note box (owner, 2026-10-21): each fact
// in Title Case, joined by a middle dot, because a fact can carry commas of its
// own ("Lives in Nieuw-West, Amsterdam, ..."). Title Case only RAISES the first
// letter of each word, so acronyms and brand casing survive ("AI-curated",
// "FC Chelsea", "F1").

export const FACTS_SEPARATOR = ' · ';

export function titleCaseWords(text: string): string {
  return text.replace(/(^|\s)(\p{Ll})/gu, (_, gap: string, letter: string) => gap + letter.toLocaleUpperCase());
}

export function factsLine(statements: readonly string[]): string {
  const seen = new Set<string>();
  const parts: string[] = [];
  for (const raw of statements) {
    const s = titleCaseWords(raw.trim());
    if (!s || seen.has(s)) continue;
    seen.add(s);
    parts.push(s);
  }
  return parts.join(FACTS_SEPARATOR);
}
