import NotSubscribedScreen from "@/components/custom/auth/NotSubscribedScreen";

// No session gate. This route is only ever reached via navigateToPaywall()
// (lib/nav-state.ts), i.e. after the server has answered a query with a 402 —
// which already proves a session exists. The old `if (!session) return
// <Redirect href="/login" />` therefore could not protect anything, but a slow
// or failed /get-session made it turn the paywall into a login screen.
//
// NotSubscribedScreen runs its own useSession and already tolerates its absence
// (checkServerSubscribed short-circuits when there is no userId), so it degrades
// to "can't verify yet" rather than ejecting.
export default function NotSubscribed() {
    return <NotSubscribedScreen />;
}
