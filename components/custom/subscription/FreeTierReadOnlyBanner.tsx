import { useAiAccess } from '@/lib/stores/subscription-store';

/**
 * Whether the AI settings screens are read-only.
 *
 * DISABLE, never hide. These screens show the user their own facts, topics and
 * preferences — hiding them behind a plan would break the same data-ownership
 * promise the rest of this mode is built on. What a plan buys is Mera ACTING on
 * these settings, so what a lapsed plan takes away is the ability to change
 * them, nothing more.
 *
 * `'unknown'` is not read-only: a paying user must not find their switches
 * frozen for the first second of a cold start.
 *
 * ## Why this file has no component in it any more
 *
 * It used to also export a pinned-bottom banner explaining the frozen controls,
 * mounted on five screens. The banner was removed as a product decision; the
 * DISABLING it explained was not.
 *
 * The file and this export deliberately kept their names. Renaming or re-homing
 * the hook would have meant edits at seven call sites plus three jest mocks
 * that pin `useFreeTierReadOnly: () => false`, and a mistake in any of those
 * grants a free user write access to a settings screen with every suite still
 * green. Five deletions and no rename is the whole change, which is a diff a
 * reviewer can check by eye — and by eye is the only way, since nothing tests
 * the removed component.
 *
 * Four of the five screens it explained (publications, sources, Mera Protocol
 * settings, persona audit) now disable their controls with no on-screen reason.
 * That is the accepted trade, not an oversight.
 */
export function useFreeTierReadOnly(): boolean {
    return useAiAccess() === 'locked';
}
