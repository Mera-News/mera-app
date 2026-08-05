import { filterGroupsByImportance } from '../dashboard-importance';
import type { FactRowGroup } from '@/lib/stores/fact-rows-selector';

function group(
  id: string,
  relevance: number,
  rawScore: number | null = null,
  eventType: string | null = null,
): FactRowGroup {
  return {
    data: { _id: id, relevance, rawScore, eventType } as any,
    members: [],
    rawScore,
    bucket: 'MEDIUM' as any,
    pubDateMs: 0,
    addedMs: 0,
    createdAtMs: 0,
    highPriority: false,
  };
}

describe('filterGroupsByImportance', () => {
  it("'low' returns the input array unchanged (same reference)", () => {
    const groups = [group('g1', 0.4), group('g2', 0.9)];
    expect(filterGroupsByImportance(groups, 'low')).toBe(groups);
  });

  it("'medium' band edge: 0.529 fails, 0.53 passes", () => {
    const groups = [group('below', 0.529), group('at', 0.53)];
    expect(filterGroupsByImportance(groups, 'medium').map((g) => g.data._id)).toEqual(['at']);
  });

  it("'high' band edge: 0.769 fails, 0.77 passes", () => {
    const groups = [group('below', 0.769), group('at', 0.77)];
    expect(filterGroupsByImportance(groups, 'high').map((g) => g.data._id)).toEqual(['at']);
  });

  it("emergency relevance (1.1) passes 'high'", () => {
    const groups = [group('emergency', 1.1)];
    expect(filterGroupsByImportance(groups, 'high').map((g) => g.data._id)).toEqual(['emergency']);
  });

  it("a breaking representative survives 'high' even at relevance 0.6", () => {
    // isBreaking: rawScore > 1.0, or >= 0.8 with a disaster/weather/conflict
    // eventType — see lib/stores/fact-rows-selector.
    const groups = [group('breaking', 0.6, 1.5, null)];
    expect(filterGroupsByImportance(groups, 'high').map((g) => g.data._id)).toEqual(['breaking']);
  });

  it("a non-breaking low-relevance group is dropped under 'high'", () => {
    const groups = [group('low-rel', 0.4, null, null)];
    expect(filterGroupsByImportance(groups, 'high')).toEqual([]);
  });
});
