import { normalizeToolName } from '../tool-names';

const PERSONA_TOOLS = [
  'saveExtractedFacts',
  'updateUserConfig',
  'deleteUserFacts',
  'issueWarning',
  'runCalibration',
  'proposeChanges',
  'applyProposal',
  'cancelProposal',
];

describe('normalizeToolName', () => {
  it('returns an exact match unchanged', () => {
    for (const name of PERSONA_TOOLS) {
      expect(normalizeToolName(name, PERSONA_TOOLS)).toBe(name);
    }
  });

  it('repairs the misspelling that used to be hardcoded', () => {
    // The single case the old `name === 'saveExtractedsFacts' ? ... : name`
    // repair covered.
    expect(normalizeToolName('saveExtractedsFacts', PERSONA_TOOLS)).toBe(
      'saveExtractedFacts',
    );
  });

  it('repairs casing and separator variants the old repair missed', () => {
    for (const variant of [
      'SaveExtractedFacts',
      'saveextractedfacts',
      'save_extracted_facts',
      'save-extracted-facts',
      'Save Extracted Facts',
    ]) {
      expect(normalizeToolName(variant, PERSONA_TOOLS)).toBe('saveExtractedFacts');
    }
  });

  it('repairs small typos within the distance threshold', () => {
    expect(normalizeToolName('runCalibraton', PERSONA_TOOLS)).toBe('runCalibration');
    expect(normalizeToolName('deleteUserFact', PERSONA_TOOLS)).toBe('deleteUserFacts');
  });

  it('rejects a genuinely unknown name rather than guessing', () => {
    expect(normalizeToolName('launchMissiles', PERSONA_TOOLS)).toBeNull();
    expect(normalizeToolName('', PERSONA_TOOLS)).toBeNull();
    expect(normalizeToolName('saveExtractedFacts', [])).toBeNull();
  });

  it('does not confuse the two similarly-named proposal tools', () => {
    expect(normalizeToolName('applyProposal', PERSONA_TOOLS)).toBe('applyProposal');
    expect(normalizeToolName('cancelProposal', PERSONA_TOOLS)).toBe('cancelProposal');
  });

  it('only ever returns a name from the supplied list', () => {
    for (const raw of ['saveExtractedsFacts', 'RUNCALIBRATION', 'nonsense']) {
      const out = normalizeToolName(raw, PERSONA_TOOLS);
      if (out !== null) expect(PERSONA_TOOLS).toContain(out);
    }
  });
});
