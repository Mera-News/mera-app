/** Opacity of a card carrying a recorded verdict (existing treatment). */
export const DIMMED_OPACITY = 0.75;

// Pressed feedback for a CARD or ROW is opt-in per surface, through
// `PressableCard`. Deliberately NOT a default on the shared
// `components/ui/pressable`: a list row that dims the moment a finger lands
// flashes on every scroll that starts on it. A dimmed card still visibly
// reacts: the press dip multiplies the 0.75.
