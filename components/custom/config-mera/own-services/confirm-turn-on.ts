import type { ConsentSessionUser } from '@/components/custom/auth/legal-consent';
import { authClient } from '@/lib/auth-client';
import { showDialog } from '@/lib/dialog';
import type { Confirmation } from '@/lib/own-services/gate';

/** The privacy policy version the person has accepted, from the signed-in session; null when unknown. */
export function useAcceptedPrivacyVersion(): string | null {
    const { data: session } = authClient.useSession();
    return (session?.user as ConsentSessionUser | undefined)?.privacyVersion ?? null;
}

/** Asks before a mode turns on. Only the affirmative button gives a confirmation; it stays on this phone. */
export async function confirmTurnOn(o: {
    title: string;
    body: string;
    yes: string;
    cancel: string;
    /** A red consequence line under the body. */
    warning?: string;
    destructive?: boolean;
    privacyVersion: string | null;
}): Promise<Confirmation | null> {
    const yes = await showDialog({
        title: o.title,
        body: o.body,
        warning: o.warning,
        confirmLabel: o.yes,
        cancelLabel: o.cancel,
        destructive: o.destructive,
    });
    return yes ? { at: Date.now(), privacyVersion: o.privacyVersion } : null;
}
