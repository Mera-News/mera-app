import NotSubscribedScreen from "@/components/custom/auth/NotSubscribedScreen";
import { useLocalSearchParams } from "expo-router";

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
    // `reason=lapsed` selects the softened mode (explanation first, no
    // auto-presented purchase sheet). Absent = the original behaviour, which is
    // also what the first-open push deliberately reuses.
    const { reason } = useLocalSearchParams<{ reason?: string }>();
    return <NotSubscribedScreen reason={reason === 'lapsed' ? 'lapsed' : undefined} />;
}
