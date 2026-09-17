// mera-harness/core — skill loading and index rendering. PURE, RN-free.
//
// The generated module is P5's; this file is the only reader of it. Ids come
// from PERSONA_SKILL_INDEX rather than from a second hand-maintained list, so
// there is one source of truth for what exists.

import {
  PERSONA_SKILLS,
  PERSONA_SKILL_INDEX,
  type PersonaSkillId,
} from '../skills/index.generated';

export type SkillId = PersonaSkillId;

/** The group preamble every leaf in that group is composed with. */
const GENERIC_SUFFIX = '/generic';

export function isGenericId(id: string): boolean {
  return id.endsWith(GENERIC_SUFFIX);
}

function groupOf(id: string): string {
  const slash = id.indexOf('/');
  return slash === -1 ? id : id.slice(0, slash);
}

function genericIdFor(id: string): string {
  return `${groupOf(id)}${GENERIC_SUFFIX}`;
}

/**
 * Every id the build knows.
 *
 * Existence, NOT content. `loadSkill` returning null cannot distinguish "that
 * id does not exist" from "that id exists and its body is empty", and the eval
 * fixture loader validates every expected id at load: a fixture naming a
 * deleted skill is a broken fixture, while an empty body is a legitimately red
 * staleness gate, and conflating them wastes a run.
 */
export function skillIds(): readonly SkillId[] {
  return PERSONA_SKILL_INDEX.map((e) => e.id);
}

export function hasSkill(id: string): boolean {
  return (skillIds() as readonly string[]).includes(id);
}

/**
 * The instructions for one skill, COMPOSED.
 *
 * A leaf arrives as its group's generic preamble followed by the leaf body: the
 * shared rules are written once and every leaf inherits them, which is why a
 * leaf leg carries roughly twice a leaf's own budget. A generic id loads ALONE,
 * with no preamble ahead of it.
 *
 * Returns null ONLY for an unknown id. An id that exists with an empty body
 * returns '' -- see skillIds().
 */
export function loadSkill(id: string): string | null {
  if (!hasSkill(id)) return null;
  const body = PERSONA_SKILLS[id as SkillId] ?? '';
  if (isGenericId(id)) return body;

  const genericId = genericIdFor(id);
  if (!hasSkill(genericId)) return body;
  const preamble = PERSONA_SKILLS[genericId as SkillId] ?? '';
  if (!preamble) return body;
  return `${preamble.trimEnd()}\n\n${body.trimStart()}`;
}

export interface SkillIndexRow {
  id: SkillId;
  when: readonly string[];
  description: string;
}

/**
 * The rows the router prompt renders.
 *
 * A `<group>/generic` skill is EXCLUDED: it is a preamble the loader composes
 * automatically, never something the router chooses. Offering it as a routable
 * destination would let the model load shared rules and no guideline.
 */
export function skillIndexRows(): SkillIndexRow[] {
  return PERSONA_SKILL_INDEX.filter((e) => !isGenericId(e.id)).map((e) => ({
    id: e.id,
    when: e.when,
    description: e.description,
  }));
}

/** One line per routable skill, for the router system prompt. */
export function renderSkillIndex(): string {
  return skillIndexRows()
    .map((row) => `- ${row.id} — ${row.when[0] ?? row.description}`)
    .join('\n');
}
