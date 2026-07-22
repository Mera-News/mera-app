import { Box } from "@/components/ui/box";
import MeraLogo from "@/components/custom/MeraLogo";
import { authClient } from "@/lib/auth-client";
import { hasLocalIdentity, resolveLaunchRoute, type LaunchRoute } from "@/lib/security/launch-route";
import { usePinStore } from "@/lib/stores/pin-store";
import { Redirect } from "expo-router";
import { useEffect, useState } from "react";

// Offline-first launch gate. Routing is decided from LOCAL facts only —
// persisted identity + PIN state — so the app launches with no network and a
// dead server session never ejects the user. useSession() is kept purely as a
// non-blocking enhancement (a fresh login whose identity hasn't been persisted
// yet), never as a gate.
export default function Index() {
  const { data: session } = authClient.useSession();
  const [route, setRoute] = useState<LaunchRoute | null>(null);

  useEffect(() => {
    let cancelled = false;

    (async () => {
      const pin = usePinStore.getState();
      if (!pin.initialized) {
        await pin.init();
      }

      let hasIdentity = await hasLocalIdentity();
      // Enhancement: a live session with no persisted identity yet (very first
      // launch after login before /logged-in ran) still counts as identified.
      if (!hasIdentity && session?.user?.id) hasIdentity = true;

      const { pinSet, locked } = usePinStore.getState();
      const target = resolveLaunchRoute({ hasIdentity, pinSet, locked });
      if (!cancelled) setRoute(target);
    })();

    return () => {
      cancelled = true;
    };
  }, [session]);

  if (route) {
    // Cast: pin-lock / pin-setup aren't in the generated typed-route map yet.
    return <Redirect href={route as any} />;
  }

  return (
    <Box className="flex-1 justify-center items-center bg-black">
      <MeraLogo size={96} animated />
    </Box>
  );
}
