import {
  clampWeight,
  nudgeTopicWeight,
  buildWrongLocationActions,
  type WrongLocationInput,
} from '../mutation-rails';
import { DEFAULT_HARNESS_CONFIG } from '../../core/config';

const R = DEFAULT_HARNESS_CONFIG.mutationRails;

describe('clampWeight', () => {
  it('clamps to [-1, 1]', () => {
    expect(clampWeight(0)).toBe(0);
    expect(clampWeight(0.5)).toBe(0.5);
    expect(clampWeight(1)).toBe(1);
    expect(clampWeight(-1)).toBe(-1);
    expect(clampWeight(1.4)).toBe(1);
    expect(clampWeight(-2.7)).toBe(-1);
  });

  it('maps NaN to 0', () => {
    expect(clampWeight(Number.NaN)).toBe(0);
  });
});

describe('nudgeTopicWeight', () => {
  it('applies a delta within budget and range', () => {
    const r = nudgeTopicWeight(0.5, 0.1, 0);
    expect(r.before).toBe(0.5);
    expect(r.after).toBeCloseTo(0.6, 6);
    expect(r.appliedDelta).toBeCloseTo(0.1, 6);
    expect(r.requestedDelta).toBe(0.1);
    expect(r.budgetExceeded).toBe(false);
  });

  it('clamps the result to the [-1, 1] band', () => {
    const up = nudgeTopicWeight(0.95, 0.2, 0);
    expect(up.after).toBe(1);
    expect(up.appliedDelta).toBeCloseTo(0.05, 6);

    const down = nudgeTopicWeight(-0.95, -0.2, 0);
    expect(down.after).toBe(-1);
    expect(down.appliedDelta).toBeCloseTo(-0.05, 6);
  });

  it('applies nothing once the day budget is exhausted', () => {
    const atBudget = nudgeTopicWeight(0.5, -0.15, R.NUDGE_DAY_BUDGET);
    expect(atBudget.appliedDelta).toBe(0);
    expect(atBudget.after).toBe(0.5);
    expect(atBudget.budgetExceeded).toBe(true);

    const overBudget = nudgeTopicWeight(0.5, 0.1, 0.5);
    expect(overBudget.appliedDelta).toBe(0);
    expect(overBudget.budgetExceeded).toBe(true);
  });

  it('clamps a partial remaining budget', () => {
    // budget 0.3, already spent 0.25 → only 0.05 remains.
    const r = nudgeTopicWeight(0.5, -0.15, 0.25);
    expect(r.appliedDelta).toBeCloseTo(-0.05, 6);
    expect(r.after).toBeCloseTo(0.45, 6);
    expect(r.budgetExceeded).toBe(true);
  });
});

describe('buildWrongLocationActions', () => {
  const baseInput = (
    over: Partial<WrongLocationInput>,
  ): WrongLocationInput => ({
    articleGeo: { city: 'Chennai', region: 'Tamil Nadu', countryCode: 'IN' },
    matchedTopics: [],
    locations: [{ city: 'Mumbai', region: 'Maharashtra', countryCode: 'IN' }],
    ...over,
  });

  it('mints a negative topic for a sibling place not among user locations', () => {
    const actions = buildWrongLocationActions(baseInput({}));
    expect(actions).toHaveLength(1);
    expect(actions[0]).toEqual({
      kind: 'add_negative_topic',
      text: 'news about chennai',
      weight: R.WRONG_LOCATION_NEG_TOPIC,
    });
  });

  it('emits no negative topic when the article place matches a user location', () => {
    const actions = buildWrongLocationActions(
      baseInput({
        articleGeo: { city: 'Mumbai', countryCode: 'IN' },
      }),
    );
    expect(actions).toHaveLength(0);
  });

  it('adds a soft suppression when bad-context entities are present', () => {
    const actions = buildWrongLocationActions(
      baseInput({
        articleGeo: { city: 'Mumbai', countryCode: 'IN' }, // matches → no neg topic
        entities: ['Local Politician', 'City Council'],
      }),
    );
    expect(actions).toHaveLength(1);
    expect(actions[0]).toEqual({
      kind: 'add_suppression',
      pattern: 'local politician, city council',
      keywords: ['local politician', 'city council'],
      strength: 0.5,
    });
    // Soft: strength below the 0.8 hard-suppression cutoff.
    expect((actions[0] as { strength: number }).strength).toBeLessThan(0.8);
  });

  it('orders negative-topic before suppression when both fire', () => {
    const actions = buildWrongLocationActions(
      baseInput({ entities: ['Some Entity'] }),
    );
    expect(actions.map((a) => a.kind)).toEqual([
      'add_negative_topic',
      'add_suppression',
    ]);
  });

  // The server's geo_tags.countryCode widened to also allow curated
  // supranational codes ("MIDDLE_EAST", "EU", …). A supranational tag carries
  // no city/region, so placeName() always falls through to the countryCode
  // branch — which must produce readable prose ("news about middle east"),
  // not a raw SCREAMING_SNAKE token with an underscore baked into the
  // on-device negative-topic search text.
  describe('supranational geo tags', () => {
    it('names the humanized place, not the raw underscored token', () => {
      const actions = buildWrongLocationActions(
        baseInput({ articleGeo: { countryCode: 'MIDDLE_EAST' } }),
      );
      expect(actions).toHaveLength(1);
      expect(actions[0]).toEqual({
        kind: 'add_negative_topic',
        text: 'news about middle east',
        weight: R.WRONG_LOCATION_NEG_TOPIC,
      });
    });

    it('EU (two letters, not a country) is also humanized', () => {
      // A length-based shortcut would leave this alone as "eu" rather than
      // resolving it to "european union".
      const actions = buildWrongLocationActions(
        baseInput({ articleGeo: { countryCode: 'EU' } }),
      );
      expect(actions[0]).toEqual({
        kind: 'add_negative_topic',
        text: 'news about european union',
        weight: R.WRONG_LOCATION_NEG_TOPIC,
      });
    });

    it('a mixed geo list still names the first tag that matches no user location', () => {
      const actions = buildWrongLocationActions(
        baseInput({
          articleGeo: [
            { city: 'Mumbai', countryCode: 'IN' }, // matches the user's location → skipped
            { countryCode: 'GULF' },
          ],
        }),
      );
      expect(actions).toHaveLength(1);
      expect(actions[0]).toEqual({
        kind: 'add_negative_topic',
        text: 'news about gulf',
        weight: R.WRONG_LOCATION_NEG_TOPIC,
      });
    });
  });
});
