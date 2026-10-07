import { router, usePathname } from 'expo-router';
import { useEffect, useRef } from 'react';
import { AppState } from 'react-native';

import { useUserStore } from '@/lib/stores/user-store';

/**
 * The sign-in gate for a session that died mid-use (Q4; it replaced the
 * ReauthBanner): when the app comes back to the foreground with the persisted
 * needsReauth verdict, the reader goes to /login?reauth=1, the one gate screen.
 * Never mid-read: only on a return, and the launch case is LoggedInGate's.
 * It never signs anyone out; local data and the PIN stay (only the Log out
 * button logs out). Renders nothing.
 */
export default function ReauthOnReturn() {
    const pathname = usePathname();
    const pathRef = useRef(pathname);
    pathRef.current = pathname;

    useEffect(() => {
        let last = AppState.currentState;
        const sub = AppState.addEventListener('change', (next) => {
            const returned = last !== 'active' && next === 'active';
            last = next;
            if (!returned) return;
            if (!useUserStore.getState().needsReauth) return;
            // Only from the app itself: the PIN screen and the gate own their
            // own routes, and a root push (an article) is still "in the app".
            if (!pathRef.current.startsWith('/logged-in')) return;
            router.replace({ pathname: '/login', params: { reauth: '1' } });
        });
        return () => sub.remove();
    }, []);

    return null;
}
