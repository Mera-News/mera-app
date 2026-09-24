// What the "New stories" pill does when tapped, as one function so the
// contract is testable without mounting the Feed.
//
// It is EXACTLY a pull-to-refresh at the top (owner decision): the same
// `onRefresh` the RefreshControl and the tab-icon re-tap call, so the re-sort,
// the re-pin and the post-commit scroll-to-top all happen the same way. It
// used to scroll down to the first arrival instead, which read as the feed
// jumping to the bottom. The pill hides first.
export function pressNewStoriesPill(hidePill: () => void, onRefresh: () => void): void {
    hidePill();
    onRefresh();
}
