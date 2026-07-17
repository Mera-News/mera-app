// Pure fact-conflict detection (Wave 11 U-B1). Dependency-free.

import { detectFactConflicts } from '../persona-management/fact-conflict';
import type { FactForConflict } from '../persona-management/fact-conflict';

function f(
  id: string,
  statement: string,
  questionnaireAttribute?: string | null,
): FactForConflict {
  return { id, statement, questionnaireAttribute };
}

describe('detectFactConflicts', () => {
  it('flags a same-attribute-key correction (kind attribute)', () => {
    const conflicts = detectFactConflicts(
      [f('n1', 'Lives in Berlin, Germany', 'location: residence')],
      [f('e1', 'Lives in Paris, France', 'location: city')],
    );
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]).toMatchObject({
      newFactId: 'n1',
      existingFactId: 'e1',
      kind: 'attribute',
      attributeKey: 'location',
    });
    expect(conflicts[0].suggestedMerge.length).toBeGreaterThan(0);
  });

  it('does NOT flag facts about different subjects (different attribute keys)', () => {
    const conflicts = detectFactConflicts(
      [f('n1', 'Parents live in Bhopal, India', 'family: parents location')],
      [f('e1', 'Lives in Porto Santo, Portugal', 'location: residence')],
    );
    expect(conflicts).toEqual([]);
  });

  it('does NOT flag two distinct interests that share an attribute label but low overlap', () => {
    // Same attribute key WOULD flag by Rule A — but these use distinct minted
    // attributes, so no attribute match, and token overlap is low.
    const conflicts = detectFactConflicts(
      [f('n1', 'Enjoys jazz music', 'interest: jazz')],
      [f('e1', 'Enjoys hiking trails', 'interest: hiking')],
    );
    expect(conflicts).toEqual([]);
  });

  it('does NOT flag identical statements (that is a duplicate, not a conflict)', () => {
    const conflicts = detectFactConflicts(
      [f('n1', 'Lives in Berlin', 'location: residence')],
      [f('e1', 'Lives in Berlin', 'location: residence')],
    );
    expect(conflicts).toEqual([]);
  });

  it('flags a high-overlap contradiction even without attributes (kind contradiction)', () => {
    const conflicts = detectFactConflicts(
      [f('n1', 'Works as senior engineer at Stripe')],
      [f('e1', 'Works as senior engineer at Google')],
    );
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0].kind).toBe('contradiction');
    expect(conflicts[0].attributeKey).toBeUndefined();
  });

  it('does NOT flag low-overlap attribute-less facts', () => {
    const conflicts = detectFactConflicts(
      [f('n1', 'Follows Formula 1 racing')],
      [f('e1', 'Invested in renewable energy stocks')],
    );
    expect(conflicts).toEqual([]);
  });

  it('returns at most one conflict per new fact, preferring the attribute match', () => {
    const conflicts = detectFactConflicts(
      [f('n1', 'Lives in Berlin, Germany', 'location: residence')],
      [
        f('e1', 'Lives in Berlin, Germany, Europe', 'other: note'), // high overlap (Rule B)
        f('e2', 'Lives in Paris, France', 'location: city'), // same key (Rule A)
      ],
    );
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0].kind).toBe('attribute');
    expect(conflicts[0].existingFactId).toBe('e2');
  });

  it('never compares a fact to itself', () => {
    const same = f('x', 'Lives in Berlin', 'location: residence');
    expect(detectFactConflicts([same], [same])).toEqual([]);
  });

  it('suggestedMerge keeps the longer statement when one contains the other', () => {
    const conflicts = detectFactConflicts(
      [f('n1', 'Lives in Berlin, Germany', 'location: residence')],
      [f('e1', 'Lives in Berlin', 'location: city')],
    );
    expect(conflicts[0].suggestedMerge).toBe('Lives in Berlin, Germany');
  });
});
