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

  it('a leaf composes ONLY when its group actually has a preamble', () => {
    // The real contract, and weaker than "every non-generic id composes":
    //  - `router` is STANDALONE. It has no group, it is not a leaf of
    //    anything, and composing it onto a preamble would be wrong.
    //  - `conversation/*` currently ships with NO `conversation/generic`, so
    //    those two load alone as well. The loader degrades to the bare body
    //    rather than failing, which is the behaviour a group without a
    //    preamble should get.
    const ids = skillIds();
    for (const id of ids) {
      if (isGenericId(id)) continue;
      const composed = loadSkill(id)!;
      const own = PERSONA_SKILLS[id].length;
      const groupGeneric = id.includes('/') ? `${id.split('/')[0]}/generic` : null;
      const hasPreamble = groupGeneric !== null && (ids as readonly string[]).includes(groupGeneric);
      if (hasPreamble) expect(composed.length).toBeGreaterThan(own);
      else expect(composed).toBe(PERSONA_SKILLS[id]);
    }
  });

  it('`router` is standalone and is never composed onto anything', () => {
    expect(loadSkill('router')).toBe(PERSONA_SKILLS.router);
  });

  it('every group preamble that EXISTS carries the ## Output contract', () => {
    // The one structural check the loader relies on: it pins the JSON shape
    // the decoder parses, so a preamble without it silently un-contracts every
    // leaf in its group.
    const preambles = skillIds().filter(isGenericId);
    expect(preambles.length).toBeGreaterThan(0);
    for (const id of preambles) {
      expect(PERSONA_SKILLS[id]).toMatch(/^##\s+Output\b/m);
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
