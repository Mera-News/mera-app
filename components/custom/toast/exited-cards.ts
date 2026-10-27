/**
 * Ids of cards that already played their OWN exit (a swipe, a notified
 * toast's flight or fade). The deck skips the exit clone for them: a clone is a
 * fresh mount at rest, so it would show the card again and then lift it away.
 * Consumed by the deck when the id leaves the queue.
 *
 * Its own module because ToastDeck pulls react-native-screens, which the
 * suites that load NotifiedToast cannot parse.
 */
const exited = new Set<string>();

export function markExited(id: string): void {
    exited.add(id);
}

/** True once per marked id; the mark is removed. */
export function takeExited(id: string): boolean {
    return exited.delete(id);
}
