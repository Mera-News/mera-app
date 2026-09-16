/**
 * The THIRD animation registry, and the only file in `components/custom/game-ui/`
 * that may hold an animation `require()`.
 *
 * Its two twins are `components/custom/processing/animation-registry.ts` and
 * `components/custom/tutorials/animation-registry.ts`. The three share one asset
 * directory and one contract and are deliberately not merged: each is the single
 * file its own area has to look at, and a third id family gets a third file.
 *
 * ── Why a registry at all ───────────────────────────────────────────────────
 * Metro resolves `require()` at BUNDLE time. A `try { require(…) } catch {}`
 * around a missing animation file is a BUILD error that no runtime guard can
 * catch. So a piece carries an id STRING and this map is the single place a
 * string becomes an asset. **An entry may exist here only once its file is on
 * disk**, and `processing/__tests__/animation-assets.test.ts` enforces that in
 * both directions: every entry has a file, and every `game-*.json` file has an
 * entry.
 *
 * ── Why this family could not go in either existing registry ────────────────
 * The processing one is typed `Partial<Record<ProcessingStageId, unknown>>`, so
 * `game-hud-idle` is not a key it can hold — that is a type error, not a matter
 * of taste. The tutorials one owns `<chapter>-<slide>` heroes plus explicit
 * `tutorial-` level pieces; filing a `game-` id there would put two families in
 * one map and, worse, invite a second `require()` site for the same file later.
 * A file claimed by two registries is two homes for one thing, and that is
 * exactly how a missing asset turns into a build failure nobody can guard.
 *
 * The id family is `game-<surface>-<moment>.json`, distinct from the other two
 * (`<chapter>-<slide>`, `processing-<stageId>`) so a file's owner is readable
 * from its name.
 *
 * ── What is actually rendered on this branch ────────────────────────────────
 * `game-hud-idle` is drawn by `components/custom/AllCaughtUpCard.tsx` on its
 * roomy branch. `game-mark-earn` has NO renderer here: there is no reward host
 * on this branch, so it is a claimed, resolvable asset and nothing more. That
 * is a supported state, not a gap to fill — the entry is what stops the orphan
 * gate reading the file as a stray, and it costs one `require()`.
 *
 * ── One-shots and loops are DIFFERENT TYPES ─────────────────────────────────
 * The split is by MEASURED duration, taken from the files themselves:
 *
 *     game-hud-idle    3.20 s   loop
 *     game-mark-earn   1.00 s   one-shot
 *
 * It is worth a type rather than a comment because the one-shot list is load
 * bearing twice over: `ONE_SHOT_IDS` in the asset gate DERIVES from
 * `GAME_REWARD_IDS` below, and `scripts/animations/validate.py` keeps a third
 * copy that `tsc` cannot reach. Adding an id to `GameRewardId` and forgetting
 * the array fails the `satisfies` below; forgetting the Python copy means the
 * asset gate validates a one-shot as a loop and fails loud on duration, which
 * is the designed failure rather than a silent pass.
 *
 * A one-shot short enough to be played once is also the thing a future reward
 * host would accept, so the narrow type is ready for one. Nothing here builds
 * that host.
 *
 * ── Reversibility ───────────────────────────────────────────────────────────
 * Comment a line out and its consumer falls back, at any N from zero to two.
 * Removing a line means removing its filename from the gate's claimed set in
 * the same commit, or the file reads as a stray.
 *
 * Plain `.json` bodymovin, already a Metro `sourceExt`. Never `.lottie`, which
 * needs an `assetExts` change plus a dotLottie runtime.
 */

/**
 * Pieces short enough to be played once as a reward, i.e. inside the asset
 * contract's 0.3–2.0 s one-shot band.
 */
export type GameRewardId = 'game-mark-earn';

/**
 * Pieces that are continuous states rather than rewards. A surface drawing one
 * owns its own player and gates it on `useAnimationsActive()`, because tabs
 * stay mounted and an ungated loop runs forever behind whatever the reader
 * walked off to.
 */
export type GameLoopId = 'game-hud-idle';

/** Every id this registry can resolve. */
export type GameAnimationId = GameRewardId | GameLoopId;

export const GAME_ANIMATIONS: Record<GameAnimationId, unknown> = {
    // ── one-shots ──────────────────────────────────────────────────────────
    'game-mark-earn': require('@/assets/animations/game-mark-earn.json'),
    // ── loops ──────────────────────────────────────────────────────────────
    'game-hud-idle': require('@/assets/animations/game-hud-idle.json'),
};

/**
 * The one-shots, as DATA.
 *
 * `animation-assets.test.ts` and `scripts/animations/validate.py` each keep a
 * one-shot list and the three must agree. This is the one the TypeScript side
 * derives from, so the type and the gate cannot drift.
 */
export const GAME_REWARD_IDS = [
    'game-mark-earn',
] as const satisfies readonly GameRewardId[];

/** The loops, as data. */
export const GAME_LOOP_IDS = [
    'game-hud-idle',
] as const satisfies readonly GameLoopId[];

/** The asset for an id, or `undefined` when it has none and must fall back. */
export function gameAnimationFor(id: GameAnimationId | null): unknown {
    if (!id) return undefined;
    return GAME_ANIMATIONS[id];
}
