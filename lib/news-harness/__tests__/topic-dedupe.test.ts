// Every case below is a real pair from the blind rater's 56-row batch, kept as
// the fixture because a synthetic example would not have found the tension the
// last two tests record.

import {
  ambientTokens,
  contentTokens,
  filterNearDuplicateTopics,
} from '../persona-management/topic-dedupe';

/** A slice of the real persona from the rater batch: a Rotterdam-based Polish
 *  expat. "rotterdam" and the Dutch/Polish words recur across it, which is what
 *  makes them ambient without anyone naming them as places. */
const EXISTING = [
  'Rotterdam local news',
  'Port of Rotterdam',
  'Dutch politics',
  'Shipping industry',
  'Data analyst careers',
  'Poland news',
  'Polish diaspora Netherlands',
  'Netherlands housing policy',
  'Rotterdam community news',
  'Rotterdam urban planning',
  'Logistics employment',
  'Port automation',
];

const reject = (proposed: string, existing: string[] = EXISTING) =>
  filterNearDuplicateTopics([proposed], existing).rejected;

describe('the rater-flagged shapes are rejected', () => {
  it('rejects an existing topic with a qualifier bolted on', () => {
    // "Shipping industry" -> "Shipping industry regulation"
    expect(reject('Shipping industry regulation')).toEqual([
      { topic: 'Shipping industry regulation', duplicateOf: 'Shipping industry' },
    ]);
  });

  it('rejects an existing topic with a PLACE swapped in', () => {
    // The shape the exclude list and any exact-match check both pass.
    expect(reject('Rotterdam logistics employment')).toHaveLength(1);
    expect(reject('Netherlands logistics employment')).toHaveLength(1);
  });

  it('rejects a proposal that says nothing the existing topic does not', () => {
    expect(reject('Rotterdam port automation')).toHaveLength(1);
  });

  it('is case and punctuation insensitive', () => {
    expect(reject('shipping-industry REGULATION')).toHaveLength(1);
  });
});

describe('real topics survive', () => {
  // These four are from the rater's strongest rows. If this block ever goes red
  // the filter has started eating the output it exists to protect.
  it.each([
    'Rotterdam port data analytics jobs',
    'Rotterdam Polish diaspora housing',
    'Gdansk Rotterdam shipping trade ties',
    'Poland dual citizenship rules',
  ])('keeps %s', (proposal) => {
    expect(reject(proposal)).toEqual([]);
  });

  it('keeps a genuinely new subject that shares one word', () => {
    expect(reject('Rotterdam bike theft')).toEqual([]);
  });
});

describe('the guards that stop this filter emptying a fact', () => {
  it('an existing topic that reduces to NOTHING matches nothing', () => {
    // "Rotterdam news" -> place + generic -> {}. Without this guard it would
    // reject every topic for a Rotterdam fact.
    const out = filterNearDuplicateTopics(
      ['Rotterdam port expansion', 'Rotterdam bike theft', 'Rotterdam air quality'],
      EXISTING,
      { ambient: new Set(['rotterdam']) },
    );
    expect(out.rejected).toEqual([]);
    expect(out.kept).toHaveLength(3);
  });

  it('a ONE-token existing topic cannot absorb a richer proposal', () => {
    // "Port of Rotterdam" -> {port}. A bare subset rule would reject anything
    // mentioning the port, including the rater's strongest row.
    expect(reject('Rotterdam port data analytics jobs')).toEqual([]);
  });

  it('a proposal that reduces to nothing is KEPT, not silently dropped', () => {
    // Deciding it is filler is the prompt's job and the rater's, not this
    // filter's; dropping it here would hide it from both.
    expect(reject('Rotterdam news')).toEqual([]);
  });

  it('a within-call duplicate is dropped, and the EARLIER one survives', () => {
    // Round-3 device capture: one four-item answer contained both of these,
    // differing only by a scope word and a place. Earlier wins because the model
    // emits its best first and the list is ranked.
    const out = filterNearDuplicateTopics(
      [
        'IJsselmeer sailing conditions',
        'IJsselmeer water quality',
        'Netherlands sailing regulations',
        'IJsselmeer sailing safety regulations',
      ],
      EXISTING,
      { ambient: new Set(['ijsselmeer', 'netherlands']) },
    );
    expect(out.kept).toEqual([
      'IJsselmeer sailing conditions',
      'IJsselmeer water quality',
      'Netherlands sailing regulations',
    ]);
    expect(out.rejected).toEqual([
      {
        topic: 'IJsselmeer sailing safety regulations',
        duplicateOf: 'Netherlands sailing regulations',
      },
    ]);
  });

  it('leaves the round-3 Add-all sets intact', () => {
    // Both facts passed on device with no filler and no duplicates; this filter
    // must not start eating them.
    const wife = filterNearDuplicateTopics(
      ['Alkmaar hospital news', 'North Holland healthcare staffing', 'Netherlands hospital policy'],
      EXISTING,
      { ambient: new Set(['netherlands', 'holland']) },
    );
    expect(wife.rejected).toEqual([]);
    const baby = filterNearDuplicateTopics(
      ['Hoorn maternity care', 'Netherlands parental leave policy', 'North Holland childcare subsidies'],
      EXISTING,
      { ambient: new Set(['netherlands', 'holland']) },
    );
    expect(baby.rejected).toEqual([]);
  });

  it('a within-call duplicate of a REJECTED proposal is still judged on its own', () => {
    // A rejected proposal never enters the comparison set, so it cannot cause a
    // cascade that empties the rest of the answer.
    const out = filterNearDuplicateTopics(
      ['Shipping industry regulation', 'Aviation biofuel trials'],
      EXISTING,
    );
    expect(out.kept).toEqual(['Aviation biofuel trials']);
  });
});

describe('ambientTokens', () => {
  it('finds the recurring place WITHOUT being told it is a place', () => {
    expect(ambientTokens(EXISTING).has('rotterdam')).toBe(true);
  });

  it('does NOT treat a word that appears once as ambient', () => {
    expect(ambientTokens(EXISTING).has('mortgage')).toBe(false);
  });

  it('returns nothing for a short list, where frequency is noise', () => {
    expect(ambientTokens(['Rotterdam news', 'Rotterdam safety']).size).toBe(0);
  });

  it('compares topics on their subject once ambient words are gone', () => {
    expect([...contentTokens('Rotterdam port emissions', new Set(['rotterdam']))].sort()).toEqual([
      'emissions',
      'port',
    ]);
  });
});

describe('the label collision this rule cannot resolve', () => {
  // The rater flagged "Rotterdam expat community news" (vs "Rotterdam community
  // news") as a duplicate, and protected "Rotterdam Polish diaspora housing"
  // (vs "Polish diaspora Netherlands"). After place and generic words are
  // stripped both are a one-token existing topic plus exactly one qualifier:
  // {community} + expat, and {diaspora} + housing. They are structurally the
  // same, so no deterministic rule separates them.
  //
  // The filter sides with the PROTECTED row, because letting a duplicate
  // through costs one weak topic while rejecting a good one is invisible.
  // Pinned so the choice stays explicit rather than becoming folklore.
  it('lets the flagged one through, in exchange for keeping the protected one', () => {
    expect(reject('Rotterdam expat community news')).toEqual([]);
    expect(reject('Rotterdam Polish diaspora housing')).toEqual([]);
  });
});
