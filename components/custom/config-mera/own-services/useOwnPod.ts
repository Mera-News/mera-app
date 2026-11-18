import { FEED_SYNC_TASK } from '@/components/custom/FeedSyncIndicator';
import { formatTimeAgo } from '@/lib/algorithms/time-ago';
import { parseServiceAddress } from '@/lib/own-services/address';
import { OwnServiceError } from '@/lib/own-services/gate';
import { ownAiState } from '@/lib/own-services/own-ai-state';
import { ownNewsState } from '@/lib/own-services/own-news-state';
import { takePendingPairLink } from '@/lib/own-services/pending-pair-link';
import { PodError, setReading, status } from '@/lib/own-services/pod-client';
import { recordPodError, usePodHealth } from '@/lib/own-services/pod-health';
import { forgetPairingAfterRefusal, pairAndErase, unpairPod } from '@/lib/own-services/pod-pairing';
import { podConfig, podHost, podState } from '@/lib/own-services/pod-state';
import { syncPod } from '@/lib/own-services/pod-runner';
import { useSchedulerStore } from '@/lib/scheduler/scheduler-store';
import { useIsOnDeviceProcessing } from '@/lib/stores/mera-protocol-store';
import { usePinStore } from '@/lib/stores/pin-store';
import { router, useFocusEffect, type Href } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useAcceptedPrivacyVersion } from './confirm-turn-on';
import { confirmPair, confirmUnpair, podHostLabel, showPodToast } from './pod-dialogs';
import { ADDRESS_ERROR_KEY, OWN_ROUTES, POD_CODE_ERROR_KEY, POD_HEALTH_KEY } from './own-services-copy';

export type PairLine = { readonly field: 'address' | 'code'; readonly text: string };

/**
 * The confirm, then the pairing. A refusal comes back as one fixed line, never the error's own text.
 * `onUnreachable` says where an unreachable server is told: under the address, or as a toast.
 */
export function usePairFlow(onUnreachable: 'address' | 'toast') {
    const { t } = useTranslation();
    const privacyVersion = useAcceptedPrivacyVersion();
    const aiOn = ownAiState.useStore((s) => s.value?.on === true);
    const newsOn = ownNewsState.useStore((s) => s.value?.on === true);
    const [busy, setBusy] = useState(false);
    const [line, setLine] = useState<PairLine | null>(null);
    const running = useRef(false);

    const run = async (input: { baseUrl: string; code: string }) => {
        if (running.current) return;
        const addr = parseServiceAddress(input.baseUrl);
        if (!addr.ok) {
            setLine({ field: 'address', text: t(ADDRESS_ERROR_KEY[addr.reason]) });
            return;
        }
        running.current = true;
        setBusy(true);
        setLine(null);
        try {
            const confirmation = await confirmPair({ t, host: podHostLabel(addr.url) ?? addr.host, ownOn: aiOn || newsOn, privacyVersion });
            if (!confirmation) return;
            try {
                await pairAndErase({ baseUrl: addr.url, code: input.code }, confirmation);
            } catch (e) {
                const code = e instanceof PodError ? e.code : null;
                if (code && code in POD_CODE_ERROR_KEY) setLine({ field: 'code', text: t(POD_CODE_ERROR_KEY[code as keyof typeof POD_CODE_ERROR_KEY]) });
                else if (code === 'unreachable' && onUnreachable === 'address') setLine({ field: 'address', text: t('ownServices.status.unreachable') });
                else if (code === 'unreachable') showPodToast(t('ownServices.pod.toast.unreachable'));
                else if (e instanceof OwnServiceError && e.code === 'address') {
                    setLine({ field: 'address', text: t(ADDRESS_ERROR_KEY[(e.reason as keyof typeof ADDRESS_ERROR_KEY) ?? 'invalid'] ?? ADDRESS_ERROR_KEY.invalid) });
                } else showPodToast(t('ownServices.pod.toast.failed'));
            }
        } finally {
            running.current = false;
            setBusy(false);
        }
    };
    return { run, busy, line };
}

/** The pod page's state: unpaired (the link's held pairing) or paired (server, reading, sync, health). */
export function useOwnPod() {
    const { t } = useTranslation();
    const hydrated = podState.useStore((s) => s.hydrated);
    const paired = podState.useStore((s) => s.value?.state === 'active');
    const onDevice = useIsOnDeviceProcessing();
    const locked = usePinStore((s) => s.locked);
    const health = usePodHealth((s) => s.health);
    const lastRun = useSchedulerStore((s) => s.taskLastRun[FEED_SYNC_TASK] ?? null);
    const pair = usePairFlow('toast');
    const [reading, setReadingValue] = useState<string | null>(null);
    const [syncing, setSyncing] = useState(false);

    useEffect(() => {
        podState.hydrate().catch(() => undefined);
    }, []);

    // A link that was opened is offered here, once the person is past the PIN. Nothing pairs without the press in the confirm.
    const offerHeldLink = pair.run;
    useFocusEffect(
        useCallback(() => {
            if (!hydrated || paired || locked || onDevice) return;
            const held = takePendingPairLink();
            if (held) void offerHeldLink({ baseUrl: held.baseUrl, code: held.code });
        }, [hydrated, paired, locked, onDevice, offerHeldLink]),
    );

    const readStatus = useCallback(async () => {
        const cfg = podConfig();
        if (!cfg) return;
        try {
            setReadingValue((await status(cfg)).reading);
        } catch (e) {
            if (e instanceof PodError) recordPodError(e);
        }
    }, []);

    useFocusEffect(
        useCallback(() => {
            if (paired) void readStatus();
        }, [paired, readStatus]),
    );

    const toggleReading = async (next: boolean) => {
        const cfg = podConfig();
        if (!cfg) return;
        try {
            setReadingValue((await setReading(cfg, !next)).reading);
        } catch (e) {
            // The switch is not moved: it still shows what the server holds.
            if (e instanceof PodError) recordPodError(e);
        }
    };

    const syncNow = async () => {
        if (syncing) return;
        setSyncing(true);
        try {
            await syncPod();
        } catch {
            // The runner has recorded the health; the line shows it.
        }
        await readStatus();
        setSyncing(false);
    };

    const unpair = async () => {
        if (await confirmUnpair(t)) await unpairPod();
    };

    return {
        hydrated,
        paired,
        host: paired ? podHost() : null,
        lastSynced: lastRun ? formatTimeAgo(t, lastRun) : null,
        readingOn: reading !== 'paused',
        readingDimmed: reading === 'pausing',
        toggleReading,
        syncing,
        syncNow,
        unpair,
        healthLine: health && health !== 'ok' ? t(POD_HEALTH_KEY[health]) : null,
        refused: health === 'refused',
        pairAgain: () => forgetPairingAfterRefusal(),
        pairError: pair.line?.text ?? null,
        pairBusy: pair.busy,
        blocked: onDevice
            ? { line: t('ownServices.onDevice.line'), button: { label: t('ownServices.onDevice.button'), onPress: () => router.navigate(OWN_ROUTES.onDevice as Href) } }
            : null,
    };
}
