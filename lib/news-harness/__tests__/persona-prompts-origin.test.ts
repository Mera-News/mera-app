// Owner ruling ux1 Q2: origin and current home are TWO facts, on every path.
// The cloud loop's skills say so; these pin the one-shot and ON-DEVICE prompts,
// which are separate text and used to instruct the opposite.

import { buildPersonaUpdateStaticPrompt } from '../prompts/persona-prompts';

const MODES = ['CLOUD', 'LOCAL'] as const;
const SURFACES = ['ONBOARDING', 'CONFIG'] as const;

describe.each(MODES)('the %s persona prompt', (mode) => {
  it.each(SURFACES)('never tells the model to combine origin and home (%s)', (surface) => {
    const p = buildPersonaUpdateStaticPrompt({ surface, mode, languageName: 'English' });
    expect(p).not.toMatch(/origin and current residence|origin\+residence/);
    // The combined shape may appear ONLY as the thing not to write.
    expect(p).not.toMatch(/ONE fact[^.\n]*living in/);
    expect(p).not.toMatch(/Compose the two/);
    expect(p).not.toMatch(/IDENTITY COMPOSITION/);
    expect(p).toContain('background: country of origin');
  });
});
