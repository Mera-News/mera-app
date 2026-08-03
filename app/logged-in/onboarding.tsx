import AbstractGradientBackdrop from '@/components/custom/AbstractGradientBackdrop';
import ErrorBoundary from "@/components/custom/ErrorBoundary";
import { FullScreenErrorFallback } from "@/components/custom/ErrorFallback";
import OnboardingScreen from "@/components/custom/onboarding/OnboardingScreen";
import { Box } from "@/components/ui/box";
import { Spinner } from "@/components/ui/spinner";
import { authClient } from "@/lib/auth-client";
import { getSetting } from "@/lib/database/services/setting-service";
import { Redirect, router } from "expo-router";
import { useEffect, useState } from "react";

export default function Onboarding() {
    // useSession is a non-blocking ENHANCEMENT, never a gate — the same contract
    // as app/index.tsx and app/logged-in/index.tsx.
    //
    // This route used to run `if (!session) return <Redirect href="/login" />`.
    // A failed or slow /get-session settles isPending=false with `session ===
    // undefined`, so that line fired for users who were perfectly signed in —
    // and login.tsx does not bounce back (the session is falsy there too), so
    // AuthScreen read cached_user_email/cached_user_id and rendered
    // PreviousUserView: the "Welcome back / We couldn't load your account just
    // now" screen, shown because of a network blip. Identity is a LOCAL fact.
    const { data: session } = authClient.useSession();
    const [userId, setUserId] = useState<string | null>(null);
    const [resolved, setResolved] = useState(false);

    useEffect(() => {
        let cancelled = false;

        (async () => {
            // try/finally rather than an early return on throw: app/login.tsx
            // sends EVERY successful login here, so this is the happy path of
            // every sign-in. A throwing getSetting on a cold DB must not leave
            // `resolved` false and strand the user on a spinner forever.
            let localUserId: string | null = null;
            try {
                localUserId = await getSetting('cached_user_id');
            } catch {
                localUserId = null;
            } finally {
                if (!cancelled) {
                    setUserId(session?.user?.id ?? localUserId ?? null);
                    setResolved(true);
                }
            }
        })();

        return () => {
            cancelled = true;
        };
    }, [session?.user?.id]);

    // reauth:'1' is load-bearing. The onboarding gate calls this when session
    // and local identity are unresolvably out of sync, and the session is still
    // live — without the param, login.tsx short-circuits on that session and
    // redirects straight back to /logged-in/onboarding, an infinite bounce.
    const handleLoginRedirect = () => {
        router.replace({ pathname: "/login", params: { reauth: "1" } });
    };

    const handleComplete = () => {
        router.replace({
            pathname: "/logged-in/app_container/for_you",
            params: { fromOnboarding: "1" },
        });
    };

    if (!resolved) {
        return (
            <Box className="flex-1 justify-center items-center">
                {/* Page background. Must be the FIRST child so it paints behind
                    everything else on the page. */}
                <AbstractGradientBackdrop />

                <Spinner size="large" />
            </Box>
        );
    }

    // The ONLY remaining route to /login from here: no identity anywhere, local
    // or live. That is a first-install / logged-out state, never a network one.
    if (!userId) {
        return <Redirect href="/login" />;
    }

    return (
        <ErrorBoundary level="screen" FallbackComponent={FullScreenErrorFallback}>
            <OnboardingScreen
                userId={userId}
                sessionUserId={session?.user?.id}
                onLoginRedirect={handleLoginRedirect}
                onComplete={handleComplete}
            />
        </ErrorBoundary>
    );
}
