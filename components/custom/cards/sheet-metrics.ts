// One spacing and type scale for the app's action sheets: the ••• menu
// (ArticleOverflowMenu), the feedback hub (FeedbackHubLevel) and Report a bug
// (FeedbackWidgetModal). The three sit side by side in one flow, and owner
// review found each with its own gaps, row heights and button heights. The
// sheet's 20pt content sides and its bottom inset are the kit's
// (components/ui/bottom-sheet), never added here.

export const SHEET = {
    /** Between controls in one group, and above the bottom plate. */
    gap: 8,
    /** Between a heading and its controls, and between groups. */
    section: 16,
    /** Every row, button and plate. */
    controlHeight: 48,
    /** Plates, buttons and fields. */
    radius: 16,
    /** A row's inner side padding and its icon-to-text gap. */
    rowInset: 14,
    rowIconGap: 12,
    iconSize: 22,
    title: { fontSize: 20, lineHeight: 26, fontWeight: '700' },
    label: { fontSize: 15, lineHeight: 20, fontWeight: '600' },
    body: { fontSize: 15, lineHeight: 21 },
    caption: { fontSize: 13, lineHeight: 18 },
} as const;
