import { Box } from "@/components/ui/box";
import AbstractGradientBackdrop from "@/components/custom/AbstractGradientBackdrop";
import ErrorBoundary from "@/components/custom/ErrorBoundary";
import { FullScreenErrorFallback } from "@/components/custom/ErrorFallback";
import LaunchLogo from "@/components/custom/auth/LaunchLogo";
import Animated, { FadeIn } from "react-native-reanimated";
import { StyleSheet } from "react-native";
import IdentitySwitchFailedScreen from "@/components/custom/auth/IdentitySwitchFailedScreen";
import AccountGateScreen from "@/components/custom/auth/AccountGateScreen";
import { useLoggedInGate } from "@/components/custom/auth/useLoggedInGate";
import { releaseSplash } from "@/lib/splash-hold";

/** S7: a render crash on the gate stays on the gate's own fallback. The async
 *  routing failures are handled by the effect's own narrowed catch. */
export default function LoggedInIndex() {
    return (
        <ErrorBoundary level="screen" FallbackComponent={FullScreenErrorFallback}>
            <LoggedInGate />
        </ErrorBoundary>
    );
}

function LoggedInGate() {
    const { gate, wipeFailed, handleRetry } = useLoggedInGate();

    // Fail closed. Nothing was stamped and nothing was routed, so this screen
    // is still mounted and is the only thing the user can see. It reads no
    // store and no persona — see its header for why that is a correctness rule
    // rather than a preference.
    if (gate) {
        return <AccountGateScreen variant={gate} onRetry={handleRetry} />;
    }

    if (wipeFailed) {
        // Rendered in place on the gate's own pathname, so no route releases
        // the held splash (lib/splash-hold.ts). Release it here.
        releaseSplash('identity-switch-failed');
        return <IdentitySwitchFailedScreen onRetry={handleRetry} />;
    }

    // Spinner while (and after) routing — the replace() unmounts this screen.
    // F1: the same unseeded backdrop every tab mounts (one shared colour
    // sequence), so the handoff is not flat black followed by a jump to colour.
    // Never on the fail-closed branch above: that screen reads nothing.
    return (
        <Box className="flex-1 justify-center items-center bg-page">
            {/* Mera starts (FinalStart #2): the gradient fades in behind the
                logo, which sits exactly where the gate hands it to the Mera button
                (LaunchLogoHandoff). No progress torch: Lite and Reduce Motion
                hold the mark still. */}
            <Animated.View entering={FadeIn.duration(300)} style={StyleSheet.absoluteFill}>
                <AbstractGradientBackdrop />
            </Animated.View>
            {/* The same working logo as the launch gate before it. */}
            <LaunchLogo size={96} working />
        </Box>
    );
}