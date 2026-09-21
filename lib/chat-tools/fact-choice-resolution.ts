// fact-choice-resolution — the PURE half of per-group fact-choice state.
//
// One `saveExtractedFacts` call stages N groups (N extracted facts) but has only
// ONE tool result. Before this module the commit REPLACED that result, which
// deleted every sibling group's derivation input: the siblings stopped being
// emitted at all, not merely hidden, and the loss was durable (the same lossy
// blob was written to `messages.toolCallsJson`). One tap resolved all N cards.
//
// The fix keeps `pendingFacts` as an immutable ordered spine and records each
// group's outcome under `groupResolutions`. Four properties are load-bearing:
//
//   1. `pendingFacts` is NEVER mutated while any group is unresolved, so a
//      card's position in the thread IS its position in that array — "replaced
//      in line, at its own position" falls out by construction rather than
//      being maintained by ordering logic that can drift.
//   2. `groupResolutions` is a SCHEMA MARKER, not "has anyone committed yet".
//      The handler writes `{}` at staging time, so its PRESENCE says "this blob
//      is group-shaped" and both legacy readers can be gated on its absence. A
//      legacy pending blob from an older bundle carries no marker and
//      materialises `{}` on its first commit, then merges from there.
//   3. A group is keyed by a stable id derived from its own `index` AND its
//      option statements — never by rendered array position, which shifts.
//   4. Every resolution entry is SELF-SUFFICIENT: it carries the display data
//      its card needs, so a card still renders after the fully-resolved rewrite
//      below drops `pendingFacts`.
//
// Pure: no store, no database, no React. Everything here is unit-testable.

import type { FactConflict } from '@/lib/news-harness/persona-management/fact-conflict';

/** One reading-group staged by `saveExtractedFacts`, awaiting a tap. */
export interface PendingFactGroup {
  index: number;
  /** Stable identity — see `factChoiceGroupId`. Absent on legacy blobs. */
  groupId?: string;
  options: string[];
  questionnaireAttribute: string | null;
  /** The existing fact this group would replace. Absent means ADD.
   *
   *  On the SPINE rather than left in the raw tool arguments, because
   *  `deriveThreadItems.deriveCard` already falls back to reading the tool
   *  INPUT when a field is absent -- that fallback is why `factsSaved: 0` has
   *  to be written explicitly -- so leaving it out would mean a second parser
   *  in the deriver and two places for the rule to drift.
   *
   *  ROLLBACK SHAPE: an older bundle reading a blob that carries this ignores
   *  it and ADDS, which degrades to a duplicate the user can delete, never to
   *  a fact destroyed by a build that did not understand the field. */
  replaces?: string;
}

/**
 * What the user did with one group.
 *
 * Self-sufficient by design: each variant carries what its rendered state needs
 * (the committed statements, or the options to restore on Undo), so rendering
 * never has to correlate an entry back against a `pendingFacts` array that the
 * fully-resolved rewrite may have dropped.
 */
export type FactChoiceResolution =
  | {
      status: 'saved';
      /** The reading actually committed — what the Saved card shows. */
      statements: string[];
      savedFacts: { id: string; statement: string }[];
      conflicts: FactConflict[];
      /**
       * Written by "Add all", not by a single Add.
       *
       * It decides card SHAPE, which is why it is recorded rather than inferred:
       * a batch-accepted group contributes to ONE merged topics card after the
       * group, while a singly-accepted group gets its own topics card in line
       * under its Saved card. Inferring it from "more than one group is saved"
       * would be wrong for the ordinary case of the user tapping Add on each
       * card in turn, which must keep its in-line cards.
       */
      batch?: boolean;
    }
  | {
      status: 'dismissed';
      /** The readings that were offered, so Undo restores the exact card. */
      options: string[];
      questionnaireAttribute: string | null;
    };

export type GroupResolutions = Record<string, FactChoiceResolution>;

/**
 * FNV-1a 32-bit, hex. Deterministic across bundles and platforms, no deps.
 *
 * Collision risk is irrelevant here: the group's `index` is already part of the
 * key, so a collision would need two groups at the SAME index carrying
 * different text, which cannot happen within one tool result.
 */
function fnv1a(input: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

/** Separator inside the hash input. Cannot occur in a fact statement. */
const HASH_SEP = String.fromCharCode(0);

/**
 * Stable identity for one group: its own `index` field plus a hash of its
 * option statements.
 *
 * NOT the rendered array position. Positions shift — `readPendingGroups` drops
 * a malformed group, and any future filter would drop more — and a resolution
 * that lands on the wrong group saves a fact the user never chose. Including the
 * option text means a shifted-but-identical group still matches its resolution,
 * while a DIFFERENT group that happens to land on a freed index does not.
 *
 * Options are normalised the way duplicate detection normalises them (trimmed,
 * lowercased), so insignificant whitespace cannot orphan a resolution.
 */
export function factChoiceGroupId(index: number, options: string[]): string {
  const key = options.map((o) => o.trim().toLowerCase()).join(HASH_SEP);
  return `${index}:${fnv1a(key)}`;
}

/**
 * The group's id, preferring the one the handler stamped.
 *
 * Legacy blobs carry none, so it is recomputed from the same inputs — which is
 * exactly what makes a pre-change PENDING blob resolvable by the new code
 * instead of being stranded.
 */
export function groupIdOf(group: PendingFactGroup): string {
  return group.groupId ?? factChoiceGroupId(group.index, group.options);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
}

/**
 * Reads `groupResolutions` off a tool result.
 *
 * Returns `null` for a LEGACY blob (no marker) and a record — possibly empty —
 * for a group-shaped one. Callers MUST distinguish those two: `null` means the
 * two legacy readers in `deriveThreadItems` (`deriveCard`'s aggregate fact-card
 * and `savedFactsWithIds`) still own this result, and `{}` means they must stay
 * silent or every group double-renders.
 */
export function readGroupResolutions(
  result: Record<string, unknown> | undefined,
): GroupResolutions | null {
  const raw = asRecord(result?.groupResolutions);
  if (!raw) return null;
  const out: GroupResolutions = {};
  for (const [id, value] of Object.entries(raw)) {
    const rec = asRecord(value);
    if (!rec) continue;
    if (rec.status === 'saved') {
      const savedFacts = (Array.isArray(rec.savedFacts) ? rec.savedFacts : [])
        .map((f) => asRecord(f))
        .filter(
          (f): f is Record<string, unknown> =>
            !!f && typeof f.id === 'string' && typeof f.statement === 'string',
        )
        .map((f) => ({ id: f.id as string, statement: f.statement as string }));
      out[id] = {
        status: 'saved',
        statements: stringArray(rec.statements),
        savedFacts,
        conflicts: Array.isArray(rec.conflicts) ? (rec.conflicts as FactConflict[]) : [],
        ...(rec.batch === true ? { batch: true as const } : {}),
      };
    } else if (rec.status === 'dismissed') {
      out[id] = {
        status: 'dismissed',
        options: stringArray(rec.options),
        questionnaireAttribute:
          typeof rec.questionnaireAttribute === 'string' ? rec.questionnaireAttribute : null,
      };
    }
  }
  return out;
}

/** Validate one raw `pendingFacts` array into groups. */
function parseSpine(value: unknown): PendingFactGroup[] {
  if (!Array.isArray(value)) return [];
  const out: PendingFactGroup[] = [];
  value.forEach((entry, fallbackIndex) => {
    const rec = asRecord(entry);
    if (!rec) return;
    const options = stringArray(rec.options).filter((o) => o.trim().length > 0);
    if (options.length === 0) return;
    out.push({
      index: typeof rec.index === 'number' ? rec.index : fallbackIndex,
      ...(typeof rec.groupId === 'string' ? { groupId: rec.groupId } : {}),
      options,
      questionnaireAttribute:
        typeof rec.questionnaireAttribute === 'string' ? rec.questionnaireAttribute : null,
      ...(typeof rec.replaces === 'string' && rec.replaces.trim().length > 0
        ? { replaces: rec.replaces }
        : {}),
    });
  });
  return out;
}

/**
 * The staged groups, validated, in their staged order.
 *
 * Falls back to `resolvedSpine` — the copy the fully-resolved rewrite parks
 * before dropping `pendingFacts`. Without that fallback an Undo on the last
 * dismissed group of a finished turn would have no spine to return the card to,
 * and the card would silently vanish instead of coming back.
 */
export function readPendingGroups(
  result: Record<string, unknown> | undefined,
): PendingFactGroup[] {
  const live = parseSpine(result?.pendingFacts);
  return live.length > 0 ? live : parseSpine(result?.resolvedSpine);
}

/** Groups with no entry in `groupResolutions` — what the composer gate counts. */
export function unresolvedGroups(
  result: Record<string, unknown> | undefined,
): PendingFactGroup[] {
  const resolutions = readGroupResolutions(result);
  if (!resolutions) return [];
  return readPendingGroups(result).filter((g) => resolutions[groupIdOf(g)] === undefined);
}

/**
 * Merge ONE group's outcome into the blob. Pure: takes the current result,
 * returns the next one. `undefined` as `resolution` REMOVES the entry, which is
 * how Undo returns a dismissed group to pending.
 *
 * When the merge leaves no group unresolved it ALSO writes the legacy
 * fully-resolved shape (top-level `savedFacts` / `conflicts` / `factsSaved`) and
 * drops `pendingFacts`. That is deliberate cover for an OTA rollback: an older
 * bundle reading a FINISHED blob sees exactly the shape it shipped with, and
 * derives the same fact-card and topic-plan cards it always did.
 *
 * RESIDUAL RISK, accepted: a rollback landing on a PARTIAL blob re-offers the
 * already-accepted cards, because the old bundle reads `pendingFacts` whole and
 * knows nothing about `groupResolutions`. The exact-match duplicate filter in
 * `filterNewFacts` absorbs the re-accept, so the cost is a redundant tap, not a
 * duplicate fact. Threads already corrupted by the pre-change bug are NOT
 * recovered — their siblings are gone from the persisted blob — and render
 * exactly as they do today.
 *
 * `groupResolutions` survives the fully-resolved rewrite, so the new bundle
 * keeps rendering per-group cards in place and only the legacy readers see the
 * flattened view.
 */
export function mergeGroupResolution(
  result: Record<string, unknown> | undefined,
  groupId: string,
  resolution: FactChoiceResolution | undefined,
): Record<string, unknown> {
  const base: Record<string, unknown> = { ...(result ?? {}) };
  const existing = readGroupResolutions(base) ?? {};
  const next: GroupResolutions = { ...existing };
  if (resolution === undefined) delete next[groupId];
  else next[groupId] = resolution;

  const spineGroups = readPendingGroups(base);
  const spine = base.pendingFacts ?? base.resolvedSpine ?? [];

  const savedFacts: { id: string; statement: string }[] = [];
  const conflicts: FactConflict[] = [];
  for (const group of spineGroups) {
    const entry = next[groupIdOf(group)];
    if (entry?.status !== 'saved') continue;
    savedFacts.push(...entry.savedFacts);
    conflicts.push(...entry.conflicts);
  }

  const allResolved =
    spineGroups.length > 0 && spineGroups.every((g) => next[groupIdOf(g)] !== undefined);

  if (allResolved) {
    const { pendingFacts: _dropped, ...rest } = base;
    return {
      ...rest,
      success: true,
      staged: false,
      groupResolutions: next,
      // Parked so an Undo after the rewrite can still restore the spine.
      resolvedSpine: spine,
      factsSaved: savedFacts.length,
      savedFacts,
      conflicts,
    };
  }

  return {
    ...base,
    success: true,
    staged: true,
    pendingFacts: spine,
    groupResolutions: next,
    // A PARTIAL blob keeps `factsSaved: 0` and empty legacy arrays, for the same
    // reason staging does: `deriveCard` falls back to reading the tool INPUT
    // when `savedFacts` is absent, so a partially resolved turn must not render
    // "Saved to your persona" over candidate statements nobody saved. The
    // per-group Saved cards say what was actually written.
    factsSaved: 0,
    savedFacts: [],
    conflicts: [],
  };
}
