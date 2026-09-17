import {
  hasSkill,
  isGenericId,
  loadSkill,
  renderSkillIndex,
  skillIds,
  skillIndexRows,
} from '../skill-loader';
import { PERSONA_SKILLS, PERSONA_SKILL_INDEX } from '../../skills/index.generated';

describe('skillIds', () => {
  it('lists every id in the generated index', () => {
    expect([...skillIds()].sort()).toEqual([...PERSONA_SKILL_INDEX.map((e) => e.id)].sort());
    expect(skillIds().length).toBeGreaterThan(0);
  });

  it('distinguishes MISSING from EMPTY, which is the whole reason it exists', () => {
    // Present in the index => loadSkill never returns null, even if a body were ''.
    for (const id of skillIds()) {
      expect(hasSkill(id)).toBe(true);
      expect(loadSkill(id)).not.toBeNull();
    }
    // Absent from the index => null, and it is NOT an empty body.
    expect(hasSkill('topics/does-not-exist')).toBe(false);
    expect(loadSkill('topics/does-not-exist')).toBeNull();
  });
});

describe('composition', () => {
  it('a LEAF is composed: group generic first, then the leaf body', () => {
    const composed = loadSkill('topics/residence');
    const generic = PERSONA_SKILLS['topics/generic'];
    const leaf = PERSONA_SKILLS['topics/residence'];

    expect(composed).not.toBeNull();
    expect(composed!.startsWith(generic.trimEnd())).toBe(true);
    expect(composed).toContain(leaf.trim().slice(0, 60));
    // Order matters: shared rules ahead of the leaf that refers back to them.
    expect(composed!.indexOf(generic.trim().slice(0, 40)))
      .toBeLessThan(composed!.indexOf(leaf.trim().slice(0, 40)));
  });

  it('a GENERIC id loads ALONE, with no preamble ahead of it', () => {
    const generic = loadSkill('topics/generic');
    expect(generic).toBe(PERSONA_SKILLS['topics/generic']);
    // Not doubled.
    const marker = '## Output';
    expect(generic!.split(marker).length - 1).toBe(1);
  });

  it('every leaf composes to strictly more than its own body', () => {
    for (const id of skillIds()) {
      if (isGenericId(id)) continue;
      const composed = loadSkill(id)!;
      expect(composed.length).toBeGreaterThan(PERSONA_SKILLS[id].length);
    }
  });
});

describe('index rendering', () => {
  it('EXCLUDES generic preambles: they are composed, never routed to', () => {
    const ids = skillIndexRows().map((r) => r.id);
    expect(ids).not.toContain('topics/generic');
    expect(ids.every((id) => !isGenericId(id))).toBe(true);
  });

  it('renders one line per routable skill', () => {
    const lines = renderSkillIndex().split('\n').filter(Boolean);
    expect(lines).toHaveLength(skillIndexRows().length);
    for (const line of lines) expect(line.startsWith('- ')).toBe(true);
  });
});
