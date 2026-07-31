// acknowledgeSeenOnly — the visible receipt for a feedback-tree leaf that
// deliberately changes nothing.
//
// Its own module rather than a second export on `apply-leaf-actions` because
// that module is jest-mocked wholesale by the tree's apply suite: a named import
// added there resolves to `undefined` at runtime in every mocked consumer, which
// is a crash disguised as a mock. The two also have genuinely different jobs —
// one mutates the persona and offers Undo, this one only speaks.

import logger from '@/lib/logger';

/**
 * Acknowledge a leaf that deliberately changes NOTHING — today only
 * `seen_already` (`leaf.seenOnly`).
 *
 * Silence would be the third different meaning for "I tapped a thumb" on this
 * surface. The caption has just told the user a bare tap is discarded and that
 * picking a reason changes the feed "right away"; picking `seen_already` then
 * produces no toast, no Activity entry, and the card still in the feed — which
 * from the user's side is indistinguishable from a broken button. That
 * ambiguity is the thing this whole wave exists to remove, so the leaf gets a
 * plain acknowledgement that says what actually happened.
 *
 * Deliberately NOT the Undo toast and NOT the filled thumb: nothing was applied,
 * so there is nothing to undo and no persona promise to make.
 *
 * Dynamic imports for the same reason as `applyLeafActions` — a surface that
 * merely renders the tree must not drag i18n or the toast entry into its graph.
 */
export async function acknowledgeSeenOnly(): Promise<void> {
  try {
    const [{ hapticLight }, { default: i18n }, { toastManager }] = await Promise.all([
      import('@/lib/haptics'),
      import('@/lib/i18n'),
      import('@/lib/toast-manager'),
    ]);
    const c = (key: string, def: string): string =>
      i18n.t(`feedbackTree.${key}`, { defaultValue: def }) as string;
    hapticLight();
    toastManager.showInfo(
      c('seenOnlyTitle', 'Noted — thanks'),
      c('seenOnlyBody', "Nothing changed in your feed: you've seen this, but that doesn't tell Mera what to show you instead."),
    );
  } catch (err) {
    logger.captureException(err, {
      tags: { component: 'applyLeafActions', method: 'acknowledgeSeenOnly' },
    });
  }
}

export default acknowledgeSeenOnly;
