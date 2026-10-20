// When HelpModal's `onClosed` runs: on iOS only from the Modal's `onDismiss`, once UIKit has
// really dismissed it. Fired at the fade's end instead, `setShown(false)` has only started the
// dismissal, so an in-app browser (or another Modal) opened from `onClosed` is presented ON the
// leaving Modal; UIKit then dismisses the browser, not the Modal, and the faded-out Modal stays
// over the whole app eating every touch. Elsewhere the fade's end is the real "gone" (as in
// BottomSheet). RN-free.
export function closedOn(os: string): 'dismiss' | 'fadeEnd' {
    return os === 'ios' ? 'dismiss' : 'fadeEnd';
}
