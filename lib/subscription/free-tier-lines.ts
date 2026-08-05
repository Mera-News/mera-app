// What Mera says while the app is on Mera News Free.
//
// Friction this removes (the repo rule: name it or don't add the pattern): the
// same set of lines is spoken by two surfaces — `MeraChatInvite`'s speech
// bubble on Profile and `FreeTierCard`'s pinned header on Feed/Dashboard. Two
// copies would drift the moment either is edited, and they are the same voice
// saying the same thing.
//
// ## The rule that shapes this file: never assert data the user does not have
//
// "The stories you follow keep everything they've collected" is a LIE for
// someone following none, and "the articles you saved are still saved" is a lie
// with zero saved. Both are exactly the kind of line that reads as reassuring
// and lands as nonsense. So the lines are split in two:
//
//   • UNCONDITIONAL — true for every locked user, no state consulted.
//   • STATE-GATED   — included only when the on-device count is > 0.
//
// The gating fails in the safe direction by construction: a count that is stale
// or unreadable omits a TRUE line (the user simply hears one fewer thing), and
// can never include a false one, because the default for "we don't know" is 0.
//
// Note the phrasing of the followed-stories line. It says the stories KEEP what
// they have collected, not that they keep collecting — the shipped
// `freeTier.storiesNotice` wording, and the distinction is real: feed-sync is
// gated on `getAiAccess() !== 'locked'`, so nothing new arrives for them while
// the plan is off. "Keeps collecting" would have been false for everyone.

/** On-device counts the state-gated lines depend on. */
export interface FreeTierLineState {
    /** Rows in the saved-articles table. */
    savedCount: number;
    /** Tracked stories with `status: 'active'`. */
    trackedCount: number;
}

/** i18n key + the state (if any) that must be non-zero for it to be true. */
interface LineSpec {
    key: string;
    requires?: keyof FreeTierLineState;
}

/**
 * The script, in speaking order.
 *
 * Deliberately INTERLEAVED — what is still true, then what Mera cannot do
 * without a plan. A block of four "I can't"s in a row reads as a hostage note.
 *
 * The achievable invariant is "never more than TWO 'cannot' lines in a row, and
 * always open and close on something the user still has" — NOT strict
 * alternation, and the arithmetic is why: there are four unconditional "cannot"
 * lines against three unconditional "can" lines, so strict alternation would
 * need five of the latter and there are not five true things to say that do not
 * depend on device state.
 *
 * The ORDERING here is what makes that invariant survive the zero state. Each
 * gated line sits between two "cannot"s, so dropping it (a brand-new user, who
 * has saved nothing and follows nothing — the DEFAULT locked user) merges those
 * two into a run of exactly two, never three. Putting both gated lines in the
 * same half would have produced a run of three for precisely the users who see
 * this first. `free-tier-lines.test.ts` pins the bound in every state; if you
 * reorder this array, run it.
 */
const SCRIPT: readonly LineSpec[] = [
    { key: 'freeTier.meraLines.exploreOpen' },
    { key: 'freeTier.meraLines.cannotRead' },
    { key: 'freeTier.meraLines.savedStay', requires: 'savedCount' },
    { key: 'freeTier.meraLines.cannotProfile' },
    { key: 'freeTier.meraLines.deviceIsYours' },
    { key: 'freeTier.meraLines.cannotAnswer' },
    { key: 'freeTier.meraLines.followedKeep', requires: 'trackedCount' },
    { key: 'freeTier.meraLines.cannotTrack' },
    { key: 'freeTier.meraLines.planSwitchesMeOn' },
];

/** The lines that never depend on device state — the guaranteed floor. */
export const UNCONDITIONAL_LINE_KEYS: readonly string[] = SCRIPT.filter(
    (l) => l.requires === undefined,
).map((l) => l.key);

/**
 * The i18n keys to speak, given what is actually on the device.
 *
 * Pure and synchronous so the truth-gating is testable without a database. The
 * hook that reads the counts lives in `use-free-tier-lines.ts`.
 */
export function freeTierLineKeys(state: FreeTierLineState): string[] {
    return SCRIPT.filter(
        (line) => line.requires === undefined || (state[line.requires] ?? 0) > 0,
    ).map((line) => line.key);
}
