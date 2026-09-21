// agent-device-port — the place-lookup ladder.
//
// The module reaches fact-service -> lib/database/index, which builds a real
// SQLiteAdapter at module scope and kills the suite at load. Mock at the
// service boundary, the same way useCloudPersonaChat.test.tsx does.
jest.mock('../../database/services/fact-similarity-service', () => ({ findSimilarFacts: jest.fn() }));
jest.mock('../../place-service', () => ({ lookupPlace: jest.fn() }));
jest.mock('../../llm/cloudComplete', () => ({ cloudChatStream: jest.fn() }));
jest.mock('../../database/services/fact-service', () => ({ getFacts: jest.fn() }));
jest.mock('../tool-handlers', () => ({
  handleDeleteUserFacts: jest.fn(),
  handleSaveExtractedFacts: jest.fn(),
}));
jest.mock('../../logger', () => ({
  __esModule: true,
  default: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

import { narrowToExact, placeQueryForms } from '../agent-device-port';
import type { Place } from '@/lib/mera-harness';

const place = (locality: string): Place => ({
  neighbourhood: undefined,
  locality,
  admin1: 'North Holland',
  countryCode: 'NL',
  countryName: 'Netherlands',
  bloc: 'EU',
});

describe('placeQueryForms', () => {
  it('falls back from the whole phrase to its words', () => {
    const forms = placeQueryForms('Nieuw-West Amsterdam');
    expect(forms[0]).toBe('Nieuw-West Amsterdam');
    expect(forms).toContain('Amsterdam');
  });
});

describe('narrowToExact', () => {
  // THE DEVICE CASE. placeSearch is an anchored PREFIX match, so the fallback
  // form "Amsterdam" returns three rows. Handing all three back read as
  // ambiguity and the agent asked "which Amsterdam?" offering
  // Amsterdam-Zuidoost and Nieuw-Amsterdam, neither of which the user said.
  it('takes the exact name over the prefix matches beside it', () => {
    const out = narrowToExact(
      [place('Amsterdam'), place('Amsterdam-Zuidoost'), place('Nieuw-Amsterdam')],
      'Amsterdam',
    );
    expect(out.map((p) => p.locality)).toEqual(['Amsterdam']);
  });

  it('is case and whitespace insensitive', () => {
    const out = narrowToExact([place('Amsterdam'), place('Amsterdam-Zuidoost')], '  amsterdam ');
    expect(out).toHaveLength(1);
  });

  // REAL AMBIGUITY SURVIVES. Two places genuinely sharing a name is the case
  // the choice chips exist for, and narrowing it would pick one at random.
  it('keeps two places that share the same name', () => {
    const tyne = { ...place('Newcastle'), admin1: 'Tyne and Wear' };
    const lyme = { ...place('Newcastle'), admin1: 'Staffordshire' };
    expect(narrowToExact([tyne, lyme], 'Newcastle')).toHaveLength(2);
  });

  it('leaves a list with no exact match alone', () => {
    const out = narrowToExact([place('Amsterdam-Zuidoost'), place('Nieuw-Amsterdam')], 'Amsterdam');
    expect(out).toHaveLength(2);
  });

  it('leaves a single result alone', () => {
    expect(narrowToExact([place('Amsterdam')], 'Amsterdam')).toHaveLength(1);
  });
});
