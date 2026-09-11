// untrusted-text — the single boundary between publisher-controlled strings and
// any prompt we build.
//
// Everything a publisher, a web page or a remote tool result puts in front of
// the model arrives here first. `asUntrusted` is the ONLY constructor: it
// sanitises AND brands in one call, so a caller cannot sanitise without
// branding (the string stays raw by accident) or brand without sanitising (the
// brand lies). Builders that accept `UntrustedText` therefore cannot be handed
// a raw publisher string without a type error.
//
// This file is pure: no react-native, expo, watermelondb, zustand or logger
// import, per the module contract in ../index.ts.

/**
 * A string that has been through `asUntrusted`. Publisher-controlled content is
 * typed as this so the type checker flags raw interpolation into a prompt.
 *
 * It is still a `string` at runtime, so it interpolates into template literals
 * normally; the brand exists only at compile time.
 */
export type UntrustedText = string & { readonly __untrusted: unique symbol };

/**
 * Structural markers that must never survive into a prompt: they are the tags
 * our own prompt scaffolding uses, so a publisher emitting one could close our
 * context or open a turn that looks like ours.
 */
const STRUCTURAL_TAG = /<\/?(?:context|tool_call|system|user|assistant)[^>]*>/gi;

/**
 * How many strip passes we will run before giving up. Stripping is applied to a
 * fixpoint because a single pass is defeatable by nesting: `<<context>context>`
 * loses its inner `<context>` on pass 1 and becomes `<context>`, a live marker
 * that a one-shot denylist would hand straight to the model.
 *
 * On exhausting the cap we return EMPTY rather than the partially-stripped
 * text. A string still producing new markers after this many passes is hostile,
 * and the half-stripped residue is exactly the thing we are defending against.
 */
const MAX_STRIP_PASSES = 8;

/** Default cap, matching the previous `sanitizeForPrompt` default. */
export const DEFAULT_UNTRUSTED_MAX_LENGTH = 500;

/**
 * Strips structural tags repeatedly until the string stops changing, so nesting
 * cannot smuggle a marker through. Returns `''` if it has not settled within
 * `MAX_STRIP_PASSES`.
 */
function stripStructuralTagsToFixpoint(input: string): string {
  let current = input;
  for (let pass = 0; pass < MAX_STRIP_PASSES; pass += 1) {
    const next = current.replace(STRUCTURAL_TAG, '');
    if (next === current) return current;
    current = next;
  }
  // Still changing after the cap: treat the whole value as hostile.
  return '';
}

/**
 * Neutralises the three shapes a publisher could use to forge prompt structure.
 * Runs AFTER tag stripping so a nested tag is removed rather than merely
 * disarmed, and after truncation so a cut can never land mid-sequence.
 *
 * Normal prose and ordinary URLs contain none of these sequences, so this is a
 * no-op for real article text in the overwhelming majority of cases.
 */
function escapeStructuralSequences(input: string): string {
  return (
    input
      // `<<` / `>>` are the article fence delimiters. Breaking the pair means no
      // publisher string can open or close a fence, whatever nonce it guesses.
      .replace(/<</g, '< <')
      .replace(/>>/g, '> >')
      // `===== Article 3 =====` is the per-article banner. Any run of three or
      // more `=` is collapsed so a description cannot draw a new section header.
      .replace(/={3,}/g, '=')
  );
}

/**
 * Sanitises a publisher-controlled string and brands it as `UntrustedText`.
 *
 * Order of operations, and why:
 *   1. `slice(0, maxLength)` on the RAW input. Truncating first means a cap can
 *      never land in the middle of an escape sequence, and it keeps every
 *      existing caller's character budget (e.g. the 220-char snippet cap)
 *      measured against the same raw text it has always been measured against.
 *      The escaped result may therefore be a few characters longer than
 *      `maxLength`; that is deliberate and is the safe direction.
 *   2. Collapse newlines and tabs to a single space. This is what stops a
 *      forged `News Title:` or `Related User Fact:` label: every field label we
 *      emit is at the start of a line, and after this step no publisher string
 *      can contain a line start at all.
 *   3. Strip structural tags to a fixpoint (see above).
 *   4. Escape the fence and banner sequences (see above).
 *   5. Collapse runs of whitespace and trim.
 *
 * Safe for short strings as well as article bodies: a tool result, a page title
 * or a URL can be passed straight through. Ordinary URLs contain none of the
 * escaped sequences and come back unchanged, so branding a URL costs nothing.
 * Pass the RAW url to anything that has to remain clickable; pass the branded
 * one to anything that becomes prompt text.
 */
export function asUntrusted(
  raw: string,
  maxLength: number = DEFAULT_UNTRUSTED_MAX_LENGTH,
): UntrustedText {
  const truncated = raw.slice(0, maxLength);
  const singleLine = truncated.replace(/[\n\r\t]+/g, ' ');
  const stripped = stripStructuralTagsToFixpoint(singleLine);
  const escaped = escapeStructuralSequences(stripped);
  return escaped.replace(/\s{2,}/g, ' ').trim() as UntrustedText;
}

/**
 * Backwards-compatible alias. Identical behaviour and identical hardening; it
 * simply does not carry the brand, for the few call sites and test mocks that
 * still reference it by this name.
 *
 * Prefer `asUntrusted` in new code — the brand is the point.
 */
export function sanitizeForPrompt(
  input: string,
  maxLength: number = DEFAULT_UNTRUSTED_MAX_LENGTH,
): string {
  return asUntrusted(input, maxLength);
}

/**
 * Characters used for a prompt nonce. Deliberately hex-like and short: it has
 * to be unguessable to a publisher writing a description hours earlier, not
 * cryptographically secret from anyone who can already read the prompt.
 */
const NONCE_ALPHABET = 'abcdef0123456789';
const NONCE_LENGTH = 12;

/**
 * A fresh random token for one prompt build.
 *
 * The fence markers carry this value, so an attacker writing article text has
 * no way to emit a matching close marker: they would have to guess 12 hex
 * characters chosen after their text was already stored.
 *
 * Injectable at every builder that uses it (the builders take an optional
 * `nonce`) so tests can pin it; production always takes this default.
 */
export function newPromptNonce(): string {
  let out = '';
  for (let i = 0; i < NONCE_LENGTH; i += 1) {
    out += NONCE_ALPHABET[Math.floor(Math.random() * NONCE_ALPHABET.length)];
  }
  return out;
}

/**
 * Wraps already-sanitised article content in a nonce fence.
 *
 * Everything between the markers is data. The system prompts say so explicitly,
 * and because the nonce is generated per build, no publisher string inside the
 * block can terminate it.
 */
export function fenceArticleBlock(nonce: string, body: string): string {
  return `<<ARTICLE ${nonce}>>\n${body}\n<</ARTICLE ${nonce}>>`;
}

/** Matches a fence marker with any nonce. Used by tests to compare structure. */
export const ARTICLE_FENCE_MARKER = /<<\/?ARTICLE [a-f0-9]{12}>>/g;
