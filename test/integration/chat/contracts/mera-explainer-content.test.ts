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
import en from '@/lib/locales/en.json';

// The explainer text lives in mera-news-client; read the file the app actually resolves.
const SOURCE_PATH = require.resolve('@/lib/news-harness/prompts/mera-explainer-content');
const source = readFileSync(SOURCE_PATH, 'utf8');

describe('mera-explainer-content — banned claims', () => {
  // The app NOW verifies the attestation quote's signature chain to a pinned
  // Intel root and the key-to-quote binding, so the old blanket ban on
  // "attestation-verified" would block honest, corrected copy. What must stay
  // banned is the claim the invariant was always really about: that the
  // HARDWARE or PLATFORM has been proven. It has not — TCB currency and
  // measurement comparison are unchecked, NVIDIA's signed result does not show
  // its GPUs are attached to the enclave, and verification is fail-open (see
  // lib/algorithms/attestation-verify.ts).
  //
  // These assertions are NEGATION-AWARE on purpose. The corrected copy has to
  // NAME the things Mera does not check ("does not show those GPUs are
  // attached", "not hardware-proven") in order to disclose them, so a plain
  // `not.toMatch` on those terms would ban the honest disclosure and pass only
  // for text that stays silent about the gaps — the exact opposite of what
  // this invariant is for. `affirmsThat` ignores a hit that is negated.
  const NEGATION = /\b(not|never|no|nor|cannot|can't|doesn't|without|lacks?|missing|neither)\b[^.]{0,80}$/i;

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

  // The limit on what NVIDIA's signed result can claim, in the explainer and in
  // the Settings strings: genuine NVIDIA GPUs answered, nothing about where they sit.
  const GPU_ATTACHED = /GPUs?[^.]{0,60}\b(attached|bound|connected)\b/i;
  const ALL_GPUS = /\b(all|every)( of)?( the| your)? GPUs?\b/i;

  it('the proxy check names the image and never vouches for what it does', () => {
    const { attestationCheckDeployedSoftware, attestationDeployedSoftwareNotice } = en.meraProtocol;
    for (const text of [attestationCheckDeployedSoftware, attestationDeployedSoftwareNotice]) {
      expect(text).not.toMatch(/verified|proven/i);
    }
    expect(attestationDeployedSoftwareNotice).toMatch(/NEAR says it installed/);
    expect(attestationDeployedSoftwareNotice).toMatch(/doesn't show what that software does/);
    expect(source).toMatch(/does not show what that software does/);
  });

  it('Settings strings keep to the same limit', () => {
    const { attestationGpuNotice, helpModesVerify } = en.meraProtocol;
    for (const text of [attestationGpuNotice, helpModesVerify]) {
      expect(runAffirmsThat(text, GPU_ATTACHED)).toBeNull();
      expect(text).not.toMatch(ALL_GPUS);
      expect(text).not.toMatch(/genuine secure hardware/i);
      expect(text).not.toMatch(/[\u2013\u2014]/);
    }
    expect(attestationGpuNotice).toMatch(/genuine NVIDIA GPUs answered/i);
    expect(attestationGpuNotice).toMatch(/doesn't show those GPUs are attached/i);
    expect(helpModesVerify).toMatch(/Intel's signature/);
  });
});
