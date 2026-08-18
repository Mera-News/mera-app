import { Box } from "@/components/ui/box";
import MeraLogo from "@/components/custom/MeraLogo";
import { authClient } from "@/lib/auth-client";
import { enforceInstallBoundary, wasInstallBoundaryReset } from "@/lib/security/install-boundary";
import { readLocalIdentityState, resolveLaunchRoute, type LaunchRoute } from "@/lib/security/launch-route";
import { purgeOrphanedLocalData } from "@/lib/security/local-wipe";
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

      // BEFORE any identity read: the keychain survives uninstall on iOS, so
      // a reinstall would otherwise silently resume the previous install's
      // session. Latched once per process; clears nothing on updates or
      // normal relaunches. See lib/security/install-boundary.ts.
      await enforceInstallBoundary();

      const identityState = await readLocalIdentityState();
      let hasIdentity = identityState === 'present';
      // Enhancement: a live session with no persisted identity yet (very first
      // launch after login before /logged-in ran) still counts as identified.
      // NOT when this process just performed the boundary reset — the atom may
      // hold a session fetched with the now-deleted cookie.
      if (!hasIdentity && session?.user?.id && !wasInstallBoundaryReset()) hasIdentity = true;

      // Offline mode is served IFF the credentials are still here. They are
      // provably gone, so anything still on disk is the previous user's data
      // left by a logout that died between clearing the credentials and
      // clearing the data — finish it before any screen can read it.
      //
      // 'absent' ONLY, never 'unknown': an unreadable keychain (cold start
      // before first unlock) must not be mistaken for a signed-out device, or
      // a transient failure would destroy a logged-in user's library.
      //
      // Safe to call on every pass — purgeOrphanedLocalData() latches itself to
      // once per process, which matters because this effect keys on `session`
      // and that changes at least twice on a cold start.
      if (!hasIdentity && identityState === 'absent') {
        await purgeOrphanedLocalData();
      }

      const { pinSet, lockEnabled, locked } = usePinStore.getState();
      const target = resolveLaunchRoute({ hasIdentity, lockEnabled, pinSet, locked });
      if (!cancelled) setRoute(target);
    })();

    return () => {
      cancelled = true;
    };
  }, [session]);

  if (route) {
    // Post-boundary-reset, /login gets the same signedOut suppression the
    // logout path uses: better-auth's atom may still hold the stale session,
    // and login.tsx would otherwise shortcut straight back into the app. The
    // param releases itself once the atom clears.
    if (route === '/login' && wasInstallBoundaryReset()) {
      return <Redirect href={{ pathname: '/login', params: { signedOut: '1' } } as any} />;
    }
    // Cast: pin-lock isn't in the generated typed-route map yet.
    return <Redirect href={route as any} />;
  }

  return (
    <Box className="flex-1 justify-center items-center bg-black">
      <MeraLogo size={96} animated />
    </Box>
  );
}
