// mera-explainer-content.test.ts — CONTENT INVARIANTS for the text the
// `explainMera` chat tool feeds the model.
//
// These are build-failing on purpose. This file's prose is the only thing
// standing between "ask me how that works" and a model answering a privacy
// question from memory, so the two claims Mera must never make, and the
// mechanism it does not publish, are checked mechanically rather than left to a
// reviewer noticing.
//
// The check runs over the RAW FILE TEXT, comments included — this repository is
// published, so a mechanism term sitting in a code comment is a leak just the
// same as one in a template literal.

import { readFileSync } from 'fs';
import { join } from 'path';

import { MERA_EXPLAINER_SECTIONS } from '../mera-explainer-content';
import { MERA_EXPLAINER_TOPIC_IDS } from '@/lib/news-harness/persona-management/persona-agent-core';

const SOURCE_PATH = join(__dirname, '..', 'mera-explainer-content.ts');
const source = readFileSync(SOURCE_PATH, 'utf8');

describe('mera-explainer-content — banned claims', () => {
  // The licence is not OSI-approved. The promo site's own CLAUDE.md forbids the
  // stronger label outright, and it is the single cheapest claim available to
  // this product, which is exactly why it is checked rather than trusted.
  it('never uses the OSI licence label', () => {
    expect(source).not.toMatch(/open[- ]source/i);
  });

  // The app NOW verifies the attestation quote's signature chain to a pinned
  // Intel root and the key-to-quote binding, so the old blanket ban on
  // "attestation-verified" would block honest, corrected copy. What must stay
  // banned is the claim the invariant was always really about: that the
  // HARDWARE or PLATFORM has been proven. It has not — TCB currency,
  // measurement comparison and GPU attestation are all unchecked, and
  // verification is fail-open (see lib/e2ee/attestation-verify.ts).
  //
  // These assertions are NEGATION-AWARE on purpose. The corrected copy has to
  // NAME the things Mera does not check ("does not verify the GPU's separate
  // attestation", "not hardware-proven") in order to disclose them, so a plain
  // `not.toMatch` on those terms would ban the honest disclosure and pass only
  // for text that stays silent about the gaps — the exact opposite of what
  // this invariant is for. `affirmsThat` ignores a hit that is negated.
  const NEGATION = /\b(not|never|no|nor|cannot|can't|without|lacks?|missing|neither)\b[^.]{0,80}$/i;

  /** Returns the offending excerpt if `pattern` appears in `text` WITHOUT a
   *  negation earlier in the same sentence; null otherwise. Parameterised on
   *  `text` so the self-test below can prove it discriminates. */
  function runAffirmsThat(text: string, pattern: RegExp): string | null {
    const re = new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : pattern.flags + 'g');
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      // Look back only as far as the start of the sentence, so a negation in a
      // previous sentence cannot excuse an affirmative claim in this one.
      const sentenceStart = text.lastIndexOf('.', m.index) + 1;
      const before = text.slice(sentenceStart, m.index);
      if (!NEGATION.test(before)) {
        return `"${text.slice(Math.max(0, m.index - 80), m.index + 80)}"`;
      }
    }
    return null;
  }
  const affirmsThat = (pattern: RegExp) => runAffirmsThat(source, pattern);

  // The guard guards nothing if it cannot fire. `affirmsThat` is now the thing
  // enforcing honesty in published copy, and a refactor that broke its regex or
  // its negation window would leave every assertion below green while the
  // invariant was dead. So prove it discriminates, on both sides.
  it('the negation-aware guard actually fires on an affirmative claim', () => {
    const probe = /hardware[- ]proven/i;
    // Affirmative → caught.
    expect(runAffirmsThat('This path is hardware-proven.', probe)).not.toBeNull();
    // Negated → ignored, so honest disclosure is not banned.
    expect(runAffirmsThat('This path is not hardware-proven.', probe)).toBeNull();
    // Negation from a PREVIOUS sentence must not leak into this one.
    expect(
      runAffirmsThat('Mera does not store facts. The chip is hardware-proven.', probe),
    ).not.toBeNull();
  });

  it('never claims the hardware or platform is proven', () => {
    expect(affirmsThat(/hardware[- ](proven|verified|attested|checked)/i)).toBeNull();
    expect(affirmsThat(/(fully|completely)[- ]verified/i)).toBeNull();
    expect(affirmsThat(/tamper[- ]proof/i)).toBeNull();
  });

  // The two claims that would be outright false. These are the checks the app
  // does NOT perform, so prose asserting them is a fabrication, not a nuance.
  it('never claims the platform firmware level or GPU attestation is checked', () => {
    expect(
      affirmsThat(/(verif|check|validat)\w*[^.]{0,60}\b(TCB|firmware|GPU)\b/i),
    ).toBeNull();
  });

  // The feature does not exist: nothing in the app generates, sends or discards
  // decoy topics, and no setting turns one on. This file claimed otherwise until
  // 2026-08, and the claim was a privacy protection users were told they had.
  // Banned affirmatively (via `affirmsThat`) so an honest DENIAL stays sayable
  // in prose and in this file's own header.
  it('never claims Mera sends decoy or noise topics', () => {
    expect(affirmsThat(/decoy/i)).toBeNull();
    // `[-\s]?` and not a literal space: "inject-noise" / "noise-injection" are
    // the forms this claim actually shipped in.
    expect(affirmsThat(/noise[-\s]?injection|inject(?:ing|s)?[-\s]?noise/i)).toBeNull();
  });

  // The disclosure must SURVIVE. A future edit that quietly drops the
  // limitations paragraph would leave copy that is technically unbanned above
  // but misleading by omission — which is how this invariant gets defeated.
  it('still discloses what is not checked, and that failures are not enforced', () => {
    const s = MERA_EXPLAINER_SECTIONS.encryption_and_inference;
    expect(s).toMatch(/still missing|does not check/i);
    expect(s).toMatch(/GPU/i);
    expect(s).toMatch(/not enforced|does not yet refuse|shown to you, not enforced/i);
    expect(s).toMatch(/not hardware-proven/i);
  });
});

describe('mera-explainer-content — pipeline confidentiality', () => {
  // The public surface is exactly: WHICH feeds (the registry repo) and THAT we
  // pre-process them. Not a stage list, not a model, not a matching method, not
  // a threshold, not an expiry window, not the infrastructure.
  const MECHANISM_TERMS =
    /hdbscan|jina|gemini|embedding|vector|cluster|cosine|cld3|bullmq|cloud run|mongo|redis/i;

  it('names no processing mechanism anywhere in the file', () => {
    const hit = source.match(MECHANISM_TERMS);
    expect(hit ? `${hit[0]} @ "${source.slice(Math.max(0, hit.index! - 60), hit.index! + 60)}"` : null)
      .toBeNull();
  });

  it('points at the public feed registry instead', () => {
    expect(MERA_EXPLAINER_SECTIONS.how_news_works).toContain(
      'github.com/Mera-News/mera-news-rss-feeds',
    );
  });
});

describe('mera-explainer-content — shape', () => {
  it('carries exactly the topic ids the tool advertises', () => {
    expect(Object.keys(MERA_EXPLAINER_SECTIONS).sort()).toEqual(
      [...MERA_EXPLAINER_TOPIC_IDS].sort(),
    );
  });

  it('gives every section real substance', () => {
    for (const [id, text] of Object.entries(MERA_EXPLAINER_SECTIONS)) {
      // id in the message so a failure names the thin section, not just a number.
      expect({ id, chars: text.length > 800 }).toEqual({ id, chars: true });
    }
  });

  // The honest passages are the reason this tool is worth shipping at all — a
  // reference document that only says flattering things is marketing, and the
  // model would be right to distrust it.
  it('keeps the known gaps honest', () => {
    const gaps = MERA_EXPLAINER_SECTIONS.known_gaps;
    for (const beat of [
      /cloud is the default/i,
      /reproducible builds/i,
      /which code a server is actually running/i,
      /account deletion/i,
      /unbounded/i,
      /third-party security assessment/i,
    ]) {
      expect(gaps).toMatch(beat);
    }
  });
});
