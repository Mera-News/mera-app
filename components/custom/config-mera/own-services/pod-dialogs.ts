import { createElement } from 'react';
import type { TFunction } from 'i18next';
import MeraToast from '@/components/custom/toast/MeraToast';
import { showDialog } from '@/lib/dialog';
import { parseServiceAddress } from '@/lib/own-services/address';
import type { Confirmation } from '@/lib/own-services/gate';
import { ownAiState } from '@/lib/own-services/own-ai-state';
import { ownNewsState } from '@/lib/own-services/own-news-state';
import { podState } from '@/lib/own-services/pod-state';
import { show } from '@/lib/toast/toast-queue';
import { confirmTurnOn } from './confirm-turn-on';

/** The server's name for a title: no scheme, no path, the port only when it is not 443. */
export function podHostLabel(baseUrl: string): string | null {
    const addr = parseServiceAddress(baseUrl);
    if (!addr.ok) return null;
    return /^https:\/\/([^/?#]*)/i.exec(addr.url)?.[1].replace(/:443$/, '') ?? addr.host;
}

/** The one confirm before pairing. Only "Erase and pair" gives a confirmation. */
export function confirmPair(o: { t: TFunction; host: string; ownOn: boolean; privacyVersion: string | null }): Promise<Confirmation | null> {
    const { t } = o;
    // The dialog has no slot after its red line, so the backup line closes the body.
    const body = [t('ownServices.pod.confirmBody'), o.ownOn ? t('ownServices.pod.confirmOwnOff') : null, t('ownServices.pod.backupsOffConfirm')]
        .filter(Boolean)
        .join('\n\n');
    return confirmTurnOn({
        title: t('ownServices.pod.confirmTitle', { host: o.host }),
        body,
        warning: t('ownServices.pod.confirmErase'),
        yes: t('ownServices.pod.erasePair'),
        cancel: t('common.cancel'),
        destructive: true,
        privacyVersion: o.privacyVersion,
    });
}

export const confirmUnpair = (t: TFunction): Promise<boolean> =>
    showDialog({
        title: t('ownServices.pod.unpairTitle'),
        body: t('ownServices.pod.unpairBody'),
        confirmLabel: t('ownServices.pod.unpair'),
        cancelLabel: t('common.cancel'),
        destructive: true,
    });

/** A one-button notice carrying one of the page's lines. */
export const showPodNotice = (t: TFunction, line: string): Promise<boolean> =>
    showDialog({ title: t('ownServices.pod.title'), body: line, confirmLabel: t('common.ok') });

export function showPodToast(title: string): void {
    show({ render: () => createElement(MeraToast, { tone: 'error', title }) });
}

/** The logout dialog's extra line: the paired line, else the own-service line, else none. */
export async function logoutLine(t: TFunction): Promise<string | null> {
    await Promise.all([podState.hydrate(), ownAiState.hydrate(), ownNewsState.hydrate()].map((p) => p.catch(() => undefined)));
    if (podState.get()) return t('ownServices.logoutPaired');
    if (ownAiState.get() || ownNewsState.get()) return t('ownServices.logoutOwn');
    return null;
}
