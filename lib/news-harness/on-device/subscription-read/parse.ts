/**
 * The read in a reply, or '' for a SKIP. A small model wraps its SKIP in quotes,
 * a code fence or punctuation, or adds a remark after it ("SKIP. Too little to
 * go on."); every one of those is a SKIP. Quotes around a real read go.
 */
export function parseSubscriptionRead(raw: string | null | undefined): string {
  const text = (raw ?? '')
    .trim()
    .replace(/^```\w*\s*|\s*```$/g, '')
    .replace(/^["'“‘]+|["'”’]+$/g, '')
    .trim();
  return /^\W*skip\b/i.test(text) ? '' : text;
}
