// The TYPE half of the untrusted-text boundary (remediation P0-4).
//
// Everything else about this boundary is asserted at runtime in the two search
// handlers' own tests. This file asserts the part a runtime test structurally
// cannot reach: that the brand is a real compile-time gate and not a comment.
//
// HOW IT VERIFIES. Each `@ts-expect-error` below FAILS THE BUILD if the line it
// guards stops being an error — `tsc` reports "Unused '@ts-expect-error'
// directive". So if someone widens `UntrustedText` back to a plain string
// alias, or a builder's parameter loses the brand, this file goes red rather
// than quietly passing. The jest assertions are incidental; `npx tsc --noEmit`
// is what runs this test.
//
// WHY THE BOUNDARY IS ESCAPE-ONLY HERE. A tool result is framed to the model as
// "here is what the search returned", not as article content, so it carries no
// `<<ARTICLE nonce>>` fence — that framing, and `fenceArticleBlock`, belong to
// the scoring and feedback prompts in `lib/news-harness/prompts`. Escaping is
// what stops a hit forging one of those markers from inside a tool result.

import { asUntrusted, type UntrustedText } from '@/lib/news-harness/prompts/untrusted-text';

describe('UntrustedText brand', () => {
  it('is produced by asUntrusted and is still a string at runtime', () => {
    const branded: UntrustedText = asUntrusted('Floods hit the delta');

    expect(typeof branded).toBe('string');
    expect(`${branded}`).toBe('Floods hit the delta');
  });

  it('rejects a raw string where the brand is required', () => {
    // A raw publisher string must not satisfy an UntrustedText parameter. This
    // is the whole point of the brand: sanitising is not optional at a site
    // that declares it.
    // @ts-expect-error — a raw string is not UntrustedText
    const notBranded: UntrustedText = 'raw publisher title';

    expect(typeof notBranded).toBe('string');
  });

  it('rejects a string built by concatenating a branded value', () => {
    const branded = asUntrusted('safe');

    // Concatenation launders the brand away, which is correct: the result is a
    // new string nobody sanitised. It must not pass as UntrustedText.
    // @ts-expect-error — concatenation yields a plain string
    const rejoined: UntrustedText = `${branded} and then some raw text`;

    expect(typeof rejoined).toBe('string');
  });

  it('still flows into a plain string parameter', () => {
    // The brand narrows, it does not obstruct: branded values must remain
    // usable everywhere a string is expected, or every call site would need a
    // cast and the casts would become the new hole.
    const accepts = (s: string) => s.length;

    expect(accepts(asUntrusted('ok'))).toBe(2);
  });

  // The nested-tag case at the constructor itself. The handlers assert it end
  // to end; this pins the reason the fix had to iterate rather than run once.
  it('strips a nested structural tag rather than creating one', () => {
    expect(asUntrusted('<<context>context>')).not.toMatch(/<\/?context[^>]*>/i);
  });
});
