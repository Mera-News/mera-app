import { authClient } from '@/lib/auth-client';
import { getSetting } from '@/lib/database/services/setting-service';
import { useUserStore } from '@/lib/stores/user-store';

/** Local-first: session, then the user store, then the cached id. Throws when none exists. */
export async function resolveCurrentUserId(): Promise<string> {
    const session = await authClient.getSession().catch(() => null);
    const id = session?.data?.user?.id ?? useUserStore.getState().userId ?? (await getSetting('cached_user_id'));
    if (!id) throw new Error('User not authenticated');
    return id;
}
