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
 * Two ids load ALONE rather than composed, and both are correct:
 *  - `router` has no group at all. It is not a leaf of anything.
 *  - a leaf whose group ships no `<group>/generic` yet, which is
 *    `conversation/*` today. Degrading to the bare body is the right
 *    behaviour: a missing preamble should cost the shared rules, not the
 *    guideline.
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
 * Groups a USER TURN can route to. Everything else is reachable, just not from
 * the index.
 *
 *  - `router` is the prompt doing the choosing. It was row 1 of its own index,
 *    described as "reads one user turn and decides", and the model duly loaded
 *    it on 112 of 312 turns: a leg spent fetching the instructions it was
 *    already following.
 *  - `topics/*` are TERMINAL guidelines for the background topic call. They
 *    are not tools and there is nothing for a chat turn to do with one.
 */
/**
 * TWO conditions, and both are needed.
 *
 * `routable` is DECLARED per skill by its author, which is better than
 * inferring it from an id convention here: the owner of the body decides
 * whether a turn can route to it, and adding a group no longer means editing
 * this file.
 *
 * The generic exclusion still applies on top, because `facts/generic` is
 * flagged routable and must NOT appear: it is a preamble the loader composes
 * onto every leaf in its group, so offering it as a destination would let the
 * model load the shared rules and no guideline at all. The flag answers "may a
 * turn route to this group"; composition answers "is this a whole skill".
 */
export function isRoutableId(id: string): boolean {
  if (isGenericId(id)) return false;
  const entry = PERSONA_SKILL_INDEX.find((e) => e.id === id) as
    | { routable?: boolean }
    | undefined;
  return entry?.routable === true;
}

/**
 * The rows the router prompt renders: loadable DESTINATIONS for a user turn,
 * and nothing else.
 *
 * A `<group>/generic` is excluded because the loader composes it automatically,
 * so offering it would let the model load shared rules and no guideline. See
 * ROUTABLE_GROUPS for why `router` and `topics/*` are excluded too.
 */
export function skillIndexRows(): SkillIndexRow[] {
  return PERSONA_SKILL_INDEX.filter((e) => isRoutableId(e.id)).map((e) => ({
    id: e.id,
    when: e.when,
    description: e.description,
  }));
}

/** One line per routable skill, for the router system prompt. */
export function renderSkillIndex(): string {
  return skillIndexRows()
    // Colon, not an em dash: the router prompt bans the character, and 12 of
    // them in its own skill index is the prompt modelling what it forbids.
    .map((row) => `- ${row.id}: ${row.when[0] ?? row.description}`)
    .join('\n');
}
