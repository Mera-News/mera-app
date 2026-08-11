// fact-check core tests — the PURE claim picker (prompt section, tool schema,
// article subject, option parsing, staging + the always-last article pill).
//
// The prompt is now a SECTION of the article agent's system prompt rather than a
// system prompt of its own (the chip sends into the existing article thread), so
// the prompt assertions live against `buildArticleFeedbackSystemPrompt` — the
// bytes production actually sends — and pin that the measured rules survived the
// move intact.

import {
  FACT_CHECK_SURFACE,
  PROPOSE_FACT_CHECK_TOOL,
  buildFactCheckPromptSection,
  decideProposeFactCheck,
  makeFactCheckSubject,
  parseFactCheckClaimOptions,
} from '../fact-check';
import {
  buildArticleFeedbackSystemPrompt,
  getArticleFeedbackToolDefinitions,
} from '../article-feedback/agent-core';

const ARTICLE = {
  articleId: 'a-1',
  title: 'RFK Jr. says children receive 80 vaccines by age 18',
  description: 'The health secretary told a Senate hearing that the schedule has tripled since 1986.',
  url: 'https://example.com/story',
  publicationName: 'France 24',
};
const SUBJECT = makeFactCheckSubject(ARTICLE);
const ARTICLE_OPTION_LABEL = 'The Article (async)';

// ---------------------------------------------------------------------------
// The measured rules, in the prompt production sends
// ---------------------------------------------------------------------------

// CLOUD-only: the section is ~1,200 measured tokens and the local path's whole
// input budget is ~3,072 — see article-feedback-core.test.ts, which pins that
// gate and the budget it defends.
describe('the claim-picker section is spliced into the ARTICLE agent prompt', () => {
  const prompt = buildArticleFeedbackSystemPrompt({ needsToolFormat: false, factCheck: true });

  it('carries the section verbatim — one copy of the measured text', () => {
    expect(prompt).toContain(buildFactCheckPromptSection());
  });

  // The v4 edit measured at 54.5% → 85.0% separability by a blinded independent
  // rater. These three sentences ARE that edit; do not reword them without
  // re-running harness-local/scripts/replay-fact-check-claims.ts.
  it('keeps the one-datum-per-card rule and its worked examples', () => {
    expect(prompt).toContain('ONE assertion per option, and ONE DATUM per card');
    expect(prompt).toContain('two good options beat four padded ones');
    expect(prompt).toContain("Delhi's AQI crossed 450");
  });

  // v6 — the two duplicate SHAPES.
  it('names both duplicate shapes as shapes, not as examples', () => {
    expect(prompt).toContain('WHO REPORTED a fact is not separate from the fact');
    expect(prompt).toContain('a SUPERLATIVE or ranking already stated inside another option');
  });

  // v5 — the Publication/Today rule. The runner builds its queries FROM the
  // claim, so an unsearchable claim is worse than a wrong one.
  it('makes the model resolve country and date from the context lines', () => {
    expect(prompt).toContain('includes a Publication line and a Today date');
    expect(prompt).toContain('cannot be searched by anyone');
  });

  it('forbids judging, and reserves the verdict for after the tap', () => {
    expect(prompt).toContain('You do NOT decide whether anything is true');
    expect(prompt).toContain('you never say what a fact-checker found');
  });

  it('tells the model the article option is appended for it', () => {
    expect(prompt).toContain('A trailing option covering the WHOLE article is added for you');
  });

  it('keeps claim payloads in English even when the reply is not', () => {
    expect(prompt).toContain('Claim labels and claim texts stay ENGLISH');
  });

  // The XML block is the LOCAL path's only tool surface, so the line only
  // appears on a prompt that is both local-format AND fact-check-enabled — a
  // combination the adapter never builds today, and pinned here so the two
  // gates cannot drift into each other.
  it('lists the tool in the XML format block only when both gates are on', () => {
    expect(
      buildArticleFeedbackSystemPrompt({ needsToolFormat: true, factCheck: true }),
    ).toContain('- proposeFactCheck: {"options": [{"label": string, "claim": string}]}');
    expect(prompt).not.toContain('<tool_call>');
  });
});

describe('the article agent declares proposeFactCheck', () => {
  it('declares it on the cloud path only', () => {
    expect(getArticleFeedbackToolDefinitions('CLOUD').map((t) => t.function.name)).toContain(
      'proposeFactCheck',
    );
    expect(getArticleFeedbackToolDefinitions('LOCAL').map((t) => t.function.name)).not.toContain(
      'proposeFactCheck',
    );
  });

  it('describes options as 2–4 and never mentions an applyProposal shortcut', () => {
    const schema = PROPOSE_FACT_CHECK_TOOL.function;
    expect(schema.description).toContain('2–4 separately checkable claims');
    expect(schema.description).toContain('never reports a finding');
    expect(schema.parameters.required).toEqual(['options']);
  });
});

// ---------------------------------------------------------------------------
// Subject
// ---------------------------------------------------------------------------

describe('makeFactCheckSubject', () => {
  it('stamps the surface and omits absent optionals', () => {
    expect(makeFactCheckSubject({ articleId: 'a', title: ' T ' })).toEqual({
      surface: FACT_CHECK_SURFACE,
      articleId: 'a',
      articleTitle: 'T',
    });
  });

  it('carries url + publication when the row has them', () => {
    expect(SUBJECT).toMatchObject({
      articleUrl: ARTICLE.url,
      publicationName: 'France 24',
    });
  });
});

// ---------------------------------------------------------------------------
// Option parsing
// ---------------------------------------------------------------------------

describe('parseFactCheckClaimOptions', () => {
  it('accepts the structured shape and a bare string', () => {
    expect(
      parseFactCheckClaimOptions([
        { label: 'L', claim: 'C.' },
        'A bare claim sentence.',
      ]),
    ).toEqual([
      { label: 'L', claim: 'C.' },
      { label: 'A bare claim sentence.', claim: 'A bare claim sentence.' },
    ]);
  });

  it('drops an option with no claim, and dedupes by CLAIM not label', () => {
    expect(
      parseFactCheckClaimOptions([
        { label: 'only a label' },
        { label: 'One wording', claim: 'Same claim.' },
        { label: 'Another wording', claim: 'SAME CLAIM.' },
      ]),
    ).toEqual([{ label: 'One wording', claim: 'Same claim.' }]);
  });

  it('caps the claims at four', () => {
    const raw = Array.from({ length: 9 }, (_, i) => ({ label: `L${i}`, claim: `Claim ${i}.` }));
    expect(parseFactCheckClaimOptions(raw)).toHaveLength(4);
  });

  // The resume path re-parses the STAGED options, article pill included. Its
  // claim is empty by design, so the claim-shaped guards must not eat it.
  it('keeps a mode:article option despite its empty claim, and puts it last', () => {
    const parsed = parseFactCheckClaimOptions([
      { label: ARTICLE_OPTION_LABEL, claim: '', mode: 'article' },
      { label: 'L', claim: 'C.' },
    ]);
    expect(parsed).toEqual([
      { label: 'L', claim: 'C.' },
      { label: ARTICLE_OPTION_LABEL, claim: '', mode: 'article' },
    ]);
  });

  // Two empty claims would collide on a `claim.toLowerCase()` dedupe key, and a
  // card must never grow a second "The Article" pill on resume.
  it('keeps exactly one article option however many are supplied', () => {
    const parsed = parseFactCheckClaimOptions([
      { label: ARTICLE_OPTION_LABEL, claim: '', mode: 'article' },
      { label: 'A second one', claim: '', mode: 'article' },
      { label: 'L', claim: 'C.' },
    ]);
    expect(parsed.filter((o) => o.mode === 'article')).toHaveLength(1);
    expect(parsed).toHaveLength(2);
  });

  it('does not count the article option against the four-claim cap', () => {
    const raw = [
      ...Array.from({ length: 4 }, (_, i) => ({ label: `L${i}`, claim: `Claim ${i}.` })),
      { label: ARTICLE_OPTION_LABEL, claim: '', mode: 'article' },
    ];
    expect(parseFactCheckClaimOptions(raw)).toHaveLength(5);
  });
});

// ---------------------------------------------------------------------------
// Staging
// ---------------------------------------------------------------------------

const OPTIONS = [
  { label: '80 vaccines by age 18', claim: 'Children in the US receive 80 vaccines by age 18.' },
  { label: 'Schedule tripled since 1986', claim: 'The US vaccine schedule tripled since 1986.' },
];

describe('decideProposeFactCheck', () => {
  it('stages one action per claim, each carrying the subject', () => {
    const staged = decideProposeFactCheck({ options: OPTIONS }, SUBJECT).sideEffects!.proposal!;

    expect(staged.actions.slice(0, 2)).toEqual([
      { type: 'fact_check_claim', label: OPTIONS[0].label, claim: OPTIONS[0].claim, subject: SUBJECT },
      { type: 'fact_check_claim', label: OPTIONS[1].label, claim: OPTIONS[1].claim, subject: SUBJECT },
    ]);
  });

  // THE always-present thorough path. The reader must be able to reach it even
  // when every proposed claim misses what they care about.
  it('appends the article option LAST, and only once', () => {
    const staged = decideProposeFactCheck(
      { options: OPTIONS },
      SUBJECT,
      ARTICLE_OPTION_LABEL,
    ).sideEffects!.proposal!;

    expect(staged.actions).toHaveLength(3);
    const last = staged.actions[2];
    expect(last).toEqual({
      type: 'fact_check_claim',
      label: ARTICLE_OPTION_LABEL,
      claim: '',
      subject: SUBJECT,
      mode: 'article',
    });
  });

  it('appends it to a LONE typed claim too — which makes that card chooseOne', () => {
    const staged = decideProposeFactCheck(
      { claim: 'The user typed this one.' },
      SUBJECT,
      ARTICLE_OPTION_LABEL,
    ).sideEffects!.proposal!;

    expect(staged.actions).toHaveLength(2);
    expect(staged.chooseOne).toBe(true);
  });

  it('echoes the staged options (article pill included) so a resume rebuilds it', () => {
    const result = decideProposeFactCheck({ options: OPTIONS }, SUBJECT, ARTICLE_OPTION_LABEL)
      .result as { options: { mode?: string }[] };

    expect(result.options).toHaveLength(3);
    expect(result.options[2].mode).toBe('article');
  });

  // "Nothing here is checkable" must stay expressible. A card carrying only the
  // article pill would answer a question the model declined to answer.
  it('refuses when no CLAIM survives parsing, article label or not', () => {
    expect(decideProposeFactCheck({ options: [] }, SUBJECT, ARTICLE_OPTION_LABEL).result).toEqual({
      error: 'options is required',
    });
    expect(
      decideProposeFactCheck(
        { options: [{ label: ARTICLE_OPTION_LABEL, claim: '', mode: 'article' }] },
        SUBJECT,
        ARTICLE_OPTION_LABEL,
      ).result,
    ).toEqual({ error: 'options is required' });
  });

  it('stages a claims-only card when no localized label is supplied', () => {
    const staged = decideProposeFactCheck({ options: OPTIONS }, SUBJECT).sideEffects!.proposal!;
    expect(staged.actions.every((a) => a.type === 'fact_check_claim' && a.mode === undefined)).toBe(
      true,
    );
  });
});
