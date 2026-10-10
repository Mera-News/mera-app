/** Case-insensitive, whitespace-collapsed comparison key. */
export function normalizeKey(s: string): string {
  return s.toLowerCase().trim().replace(/\s+/g, ' ');
}

export function normalizeKeyOrEmpty(s: string | null | undefined): string {
  return normalizeKey(s ?? '');
}
