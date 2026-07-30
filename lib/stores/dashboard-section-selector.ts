// dashboard-section-selector — what a Dashboard section shows in its collapsed
// preview.
//
// This module used to own the preview's ORDERING (`compareByPriority` /
// `selectTopGroups`) and its "new since last visit" badge maths
// (`isGroupNew` / `countNewGroups`). Both are gone:
//
//  • Ordering moved to lib/feed-ordering/priority-order, which the Feed tab uses
//    too — the Dashboard preview is now simply the top N of that one shared
//    rule, so the two surfaces cannot rank the same story differently.
//  • The "+N new" badge was removed from the section header entirely (owner
//    decision): the section's TOTAL is the number that says something durable
//    about it, and two counts competed for the same corner.
//
// What remains is the one thing that is genuinely this module's: how many cards
// a collapsed section previews.

/** Number of story cards shown in a section's collapsed preview. */
export const SECTION_PREVIEW_COUNT = 3;
