// ux2 F3: the deferred combination pass prompt. Derived from the shipped combo
// prompt, which stays byte-identical so the topic eval's 'current' arm still
// measures today's behaviour.

import {
  CLOUD_FACT_COMBO_TOPIC_GENERATION_SYSTEM_PROMPT,
  COMBO_PASS_MAX_TOPICS,
  COMBO_PASS_TOPIC_SYSTEM_PROMPT,
  buildComboPassUserMessage,
} from '../prompts/persona-prompts';

describe('COMBO_PASS_TOPIC_SYSTEM_PROMPT', () => {
  it('names no location line and no sibling prompt', () => {
    expect(COMBO_PASS_TOPIC_SYSTEM_PROMPT).not.toMatch(/User location/);
    expect(COMBO_PASS_TOPIC_SYSTEM_PROMPT).not.toMatch(/sibling/i);
  });

  it('keeps the combination rules it inherits', () => {
    for (const rule of ['## Combo rule (hard requirement)', '## Entity cap (hard requirement)', '## News-shape rule (hard requirement)', 'ORIGIN / IMMIGRATION CARVE-OUT']) {
      expect(COMBO_PASS_TOPIC_SYSTEM_PROMPT).toContain(rule);
    }
  });

  it('still anchors a personal fact to where an Other fact says the user lives', () => {
    expect(COMBO_PASS_TOPIC_SYSTEM_PROMPT).toMatch(/Other user facts: Lives in Amsterdam, Netherlands; Works in tech; Has young children/);
  });

  it('leaves the shipped combo prompt untouched', () => {
    expect(CLOUD_FACT_COMBO_TOPIC_GENERATION_SYSTEM_PROMPT).toMatch(/User location/);
  });
});

describe('buildComboPassUserMessage', () => {
  it('carries the fact, the supporting facts and the ceiling, and no location line', () => {
    const msg = buildComboPassUserMessage('Works as a nurse', ['Lives in Porto, Portugal, EU', 'From India']);
    expect(msg).toBe(
      `Fact: "Works as a nurse"\nOther user facts: Lives in Porto, Portugal, EU; From India\nGenerate at most ${COMBO_PASS_MAX_TOPICS} topics`,
    );
  });

  it('escapes what it interpolates', () => {
    expect(buildComboPassUserMessage('a <<b>>', ['c'])).not.toContain('<<');
  });
});


describe('ux2 F6: every combination topic names its Fact', () => {
  it('says so as a hard rule, with an example', () => {
    expect(COMBO_PASS_TOPIC_SYSTEM_PROMPT).toContain('## Name the Fact (hard requirement)');
    expect(COMBO_PASS_TOPIC_SYSTEM_PROMPT).toMatch(/Every topic contains at least one word from the Fact itself/);
  });

  it('carries no example that breaks it', () => {
    for (const bad of ['"India remittance rules for tech expats"', '"international schools Amsterdam"', '"Randstad international school options"', '"Formula 1 AI research"', '"UK-EU AI talent mobility"']) {
      expect(COMBO_PASS_TOPIC_SYSTEM_PROMPT).not.toContain(bad);
    }
  });
});
