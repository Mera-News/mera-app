// The reason prompt after reason-v2 was promoted, plus the arms around it.
//
// A promotion is the moment a measurement can quietly stop being true: the
// shipped prompt has to be the string that was actually rated, and the thing it
// beat has to remain available or the comparison cannot be repeated. Both are
// asserted here rather than trusted.
import {
  CLOUD_REASON_SYSTEM_PROMPT,
  CLOUD_HEADLINE_REASON_SYSTEM_PROMPT,
  CLOUD_REASON_SYSTEM_PROMPT_V1,
  CLOUD_HEADLINE_REASON_SYSTEM_PROMPT_V1,
  CLOUD_REASON_SYSTEM_PROMPT_PRE_GEO,
  CLOUD_HEADLINE_REASON_SYSTEM_PROMPT_PRE_GEO,
  LOCAL_REASON_SYSTEM_PROMPT,
  resolvePromptVariant,
  promptVariantIds,
  REASON_V1_ID,
  REASON_V3_ID,
} from '../index';
import { relevanceSystemPromptFor, reasonSystemPromptFor } from '../article-pipeline/scoring';
import { DEFAULT_HARNESS_CONFIG } from '../core/config';
import { estimateTokens } from '@/lib/llm/tokens';
import { undoUx1ReasonLabelRule } from './ux1-reason-label';

const CFG = DEFAULT_HARNESS_CONFIG.articlePipeline;

describe('the promoted reason prompt', () => {
  it('is the pre-promotion text plus the rules, in that order', () => {
    // Byte-level, because "we promoted the arm" is only true if the shipped
    // string is the one the rater scored. Rebuilding it by hand, or tidying the
    // halves into a single literal, would silently break that.
    //
    // Asserted against the `_PRE_GEO` composites, not the shipped ones: the
    // article-scope promotion moved the shipped prompts onto a different base,
    // and `_V1` is deliberately frozen on the base the rater actually saw.
    expect(CLOUD_REASON_SYSTEM_PROMPT_PRE_GEO.startsWith(CLOUD_REASON_SYSTEM_PROMPT_V1)).toBe(
      true,
    );
    expect(
      CLOUD_HEADLINE_REASON_SYSTEM_PROMPT_PRE_GEO.startsWith(
        CLOUD_HEADLINE_REASON_SYSTEM_PROMPT_V1,
      ),
    ).toBe(true);
  });

  it('adds the same block to both reason prompts', () => {
    const a = CLOUD_REASON_SYSTEM_PROMPT_PRE_GEO.slice(CLOUD_REASON_SYSTEM_PROMPT_V1.length);
    const b = CLOUD_HEADLINE_REASON_SYSTEM_PROMPT_PRE_GEO.slice(
      CLOUD_HEADLINE_REASON_SYSTEM_PROMPT_V1.length,
    );
    expect(a).toBe(b);
  });

  it('is the pre-geo text plus the article-scope rule and the ux1 label rule, and nothing else', () => {
    // The second promotion, asserted the same way as the first: cut the one
    // section back out, undo the named ux1 label edit, and the archived string
    // must return byte for byte.
    const cut = (p: string) => undoUx1ReasonLabelRule(p.replace(/\n\n## Article scope\n[^\n]*/, ''));
    expect(cut(CLOUD_REASON_SYSTEM_PROMPT)).toBe(CLOUD_REASON_SYSTEM_PROMPT_PRE_GEO);
    // NOT asserted for the headline twin: it took a SECOND change after the
    // promotion, dropping the anchor table to fit the gateway wire cap. Its
    // two-difference shape is pinned in geofix-arms.test.ts instead, where the
    // anchors can be named. Asserting one difference here would go green again
    // the day someone put the anchors back and blew the cap.
    expect(cut(CLOUD_HEADLINE_REASON_SYSTEM_PROMPT)).not.toBe(
      CLOUD_HEADLINE_REASON_SYSTEM_PROMPT_PRE_GEO,
    );
  });

  it('carries the three rules that were measured', () => {
    for (const p of [CLOUD_REASON_SYSTEM_PROMPT, CLOUD_HEADLINE_REASON_SYSTEM_PROMPT]) {
      expect(p).toMatch(/0\.6 and 0\.8/);
      expect(p).toMatch(/Never describe the feed/);
      expect(p).toMatch(/the connection is loose/);
    }
  });

  it('ends on the output contract', () => {
    for (const p of [CLOUD_REASON_SYSTEM_PROMPT, CLOUD_HEADLINE_REASON_SYSTEM_PROMPT]) {
      expect(p.trimEnd()).toMatch(/Output: single plain string, no prefixes, no markdown\.$/);
    }
  });

  it('never reached the on-device prompt', () => {
    // The promotion is cloud-only. LOCAL is built on a different base and states
    // its voice rule inline, so nothing here can touch it, and nothing measures
    // it either.
    expect(LOCAL_REASON_SYSTEM_PROMPT).not.toMatch(/Three additional rules/);
    expect(LOCAL_REASON_SYSTEM_PROMPT).not.toMatch(/Never describe the feed/);
  });
});

describe('the arms around it', () => {
  it('registers reason-v1 and reason-v3, and NOT reason-v2', () => {
    // reason-v2 IS the default now, so an arm by that name would just be the
    // shipped prompt under another id - the kind of thing that makes a later
    // result impossible to interpret.
    const ids = promptVariantIds();
    expect(ids).toContain(REASON_V1_ID);
    expect(ids).toContain(REASON_V3_ID);
    expect(ids).not.toContain('reason-v2');
  });

  it('reason-v1 is the pre-promotion text, exactly', () => {
    const v1 = resolvePromptVariant(REASON_V1_ID).systemPrompts!;
    expect(v1.reason).toBe(CLOUD_REASON_SYSTEM_PROMPT_V1);
    expect(v1.headlineReason).toBe(CLOUD_HEADLINE_REASON_SYSTEM_PROMPT_V1);
    // And it is genuinely different from what ships, or it is not a control.
    expect(v1.reason).not.toBe(CLOUD_REASON_SYSTEM_PROMPT);
  });

  it('reason-v3 is the SHIPPED prompt plus its own rules', () => {
    // v3 must build on v2, not on v1, or a v3-vs-v2 comparison measures both
    // changes at once.
    const v3 = resolvePromptVariant(REASON_V3_ID).systemPrompts!;
    expect(v3.reason!.startsWith(CLOUD_REASON_SYSTEM_PROMPT)).toBe(true);
    expect(v3.headlineReason!.startsWith(CLOUD_HEADLINE_REASON_SYSTEM_PROMPT)).toBe(true);
    expect(v3.reason).toMatch(/A place belongs in the sentence only when the ARTICLE has an angle/);
    expect(v3.reason).toMatch(/Vary how the sentence opens/);
  });

  it('neither arm touches scoring or the text cap', () => {
    for (const id of [REASON_V1_ID, REASON_V3_ID]) {
      expect(relevanceSystemPromptFor(CFG, 'standard', id)).toBe(CFG.relevanceSystemPrompt);
      expect(relevanceSystemPromptFor(CFG, 'headline', id)).toBe(CFG.headlineRelevanceSystemPrompt);
      expect(resolvePromptVariant(id).articleTextMaxLength).toBeUndefined();
    }
  });

  it('routes the reason slots per arm', () => {
    expect(reasonSystemPromptFor(CFG, 'standard')).toBe(CLOUD_REASON_SYSTEM_PROMPT);
    expect(reasonSystemPromptFor(CFG, 'standard', REASON_V1_ID)).toBe(
      CLOUD_REASON_SYSTEM_PROMPT_V1,
    );
    expect(reasonSystemPromptFor(CFG, 'headline', REASON_V1_ID)).toBe(
      CLOUD_HEADLINE_REASON_SYSTEM_PROMPT_V1,
    );
  });

  it('writes its rules without the punctuation the product bans', () => {
    const added = resolvePromptVariant(REASON_V3_ID).systemPrompts!.reason!.slice(
      CLOUD_REASON_SYSTEM_PROMPT.length,
    );
    expect(added).not.toMatch(/[—–―]/);
  });
});

describe('measured sizes after the promotion', () => {
  // Restated on purpose: the reason pass sends one call per article that clears
  // the gate, so these ride on every scored article.
  it('pins the promoted prompts', () => {
    expect(estimateTokens(CLOUD_REASON_SYSTEM_PROMPT)).toBe(5511);
    // Smaller than its pre-promotion twin, not larger: the headline reason
    // prompt gained the 130-token rule and then dropped the 1428-token anchor
    // table to fit the gateway wire cap. golden-prompts.test.ts owns that guard.
    expect(estimateTokens(CLOUD_HEADLINE_REASON_SYSTEM_PROMPT)).toBe(7066);
  });

  it('pins the pre-promotion prompts, which are now the control arms', () => {
    // reason-v1: the text reason-v2 beat, on the pre-geo base.
    expect(estimateTokens(CLOUD_REASON_SYSTEM_PROMPT_V1)).toBe(4839);
    expect(estimateTokens(CLOUD_HEADLINE_REASON_SYSTEM_PROMPT_V1)).toBe(7693);
    // pre-geo-control: v2's rules, on the pre-geo base. What ships today beat
    // exactly these two strings.
    expect(estimateTokens(CLOUD_REASON_SYSTEM_PROMPT_PRE_GEO)).toBe(5271);
    expect(estimateTokens(CLOUD_HEADLINE_REASON_SYSTEM_PROMPT_PRE_GEO)).toBe(8126);
  });

  it('costs 432 tokens per reason call to have promoted the v2 rules', () => {
    expect(
      estimateTokens(CLOUD_REASON_SYSTEM_PROMPT_PRE_GEO)
        - estimateTokens(CLOUD_REASON_SYSTEM_PROMPT_V1),
    ).toBe(432);
  });

  it('costs 130 tokens per call to have promoted the article-scope rule', () => {
    // One section in the shared base, so the same 130 on every prompt built on
    // it. The reason pass sends one call per article that clears the gate, so
    // this rides on every scored article, and pass 1 pays it per batch of five.
    // Measured with the ux1 label edit taken back out, which is its own named
    // change (see ux1-reason-label.ts), so this still isolates the promotion.
    expect(
      estimateTokens(undoUx1ReasonLabelRule(CLOUD_REASON_SYSTEM_PROMPT))
        - estimateTokens(CLOUD_REASON_SYSTEM_PROMPT_PRE_GEO),
    ).toBe(130);
    // The headline reason prompt is NOT comparable this way: it also lost the
    // anchor table to the wire cap, so its delta is the sum of two changes.
    // Asserting 130 here would silently pin that second change as if it were
    // part of the promotion. It also gained RULE_NAME_BAN (ux1, +108), so the
    // delta is the sum of three changes.
    expect(
      estimateTokens(CLOUD_HEADLINE_REASON_SYSTEM_PROMPT_PRE_GEO)
        - estimateTokens(CLOUD_HEADLINE_REASON_SYSTEM_PROMPT),
    ).toBe(1060);
  });
});
