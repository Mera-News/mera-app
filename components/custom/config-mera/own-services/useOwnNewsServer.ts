import { parseServiceAddress } from '@/lib/own-services/address';
import { checkOwnNews } from '@/lib/own-services/check-news';
import { OwnServiceError, ownServicesAllowed } from '@/lib/own-services/gate';
import { missingFeatures } from '@/lib/own-services/news-operations';
import { latchedOperations } from '@/lib/own-services/news-latch';
import { ownNewsState, recordOwnNewsCheck, saveOwnNewsFields, setOwnNewsOn } from '@/lib/own-services/own-news-state';
import { podState } from '@/lib/own-services/pod-state';
import { useRestartHold } from '@/lib/app-restart';
import { useIsOnDeviceProcessing } from '@/lib/stores/mera-protocol-store';
import { router, type Href } from 'expo-router';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { confirmTurnOn, useAcceptedPrivacyVersion } from './confirm-turn-on';
import { ADDRESS_ERROR_KEY, NEWS_STATUS_KEY, OWN_ROUTES } from './own-services-copy';

/** What the person's server lacks: null when it did not say, otherwise the features it cannot serve. */
export function useMissingFeatures() {
    const cfg = ownNewsState.useStore((s) => s.value);
    return missingFeatures(cfg?.fields ?? null, latchedOperations());
}

/** The page's state. Call it once the stored config is read in: the fields start from it. */
export function useOwnNewsServer() {
    const { t } = useTranslation();
    const cfg = ownNewsState.useStore((s) => s.value);
    const onDevice = useIsOnDeviceProcessing();
    const paired = podState.useStore((s) => s.value?.state === 'active');
    const missing = useMissingFeatures();
    const [address, setAddress] = useState(cfg?.baseUrl ?? '');
    const [key, setKey] = useState(cfg?.key ?? '');
    const [checking, setChecking] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const trimmed = address.trim();
    const parsed = trimmed ? parseServiceAddress(trimmed) : null;
    const url = parsed?.ok ? parsed.url : null;
    const addressError = parsed && !parsed.ok ? t(ADDRESS_ERROR_KEY[parsed.reason]) : null;
    const keyText = key.trim() || null;
    const dirty = (url ?? trimmed) !== (cfg?.baseUrl ?? '') || keyText !== (cfg?.key ?? null);
    const on = cfg?.on === true;

    useRestartHold(dirty, 'draft:own-news', 'hard');
    // Typing never moves the profile: the stored service stays in use until Check saves the new fields,
    // and that save turns the switch off (the state module's rule), so the person turns it back on knowingly.

    const status = !dirty && !checking ? (cfg?.status ?? null) : null;
    const reasonText = status && status !== 'connected' ? t(NEWS_STATUS_KEY[status]) : null;
    const statusLine = status
        ? status === 'connected'
            ? { ok: true, text: t(NEWS_STATUS_KEY.connected) }
            : { ok: false, text: on ? t('ownServices.lastCheckFailed', { reason: reasonText }) : (reasonText ?? '') }
        : null;
    const offLine = !on && url != null && !status && !checking ? t('ownServices.offUntilChecked') : null;

    const gated = !on && !ownServicesAllowed();
    const blocked = !on && onDevice;
    // Pairing turned this service off; the person unpairs before using it again.
    const reason = paired
        ? { line: t('ownServices.pod.unpairFirst') }
        : gated
        ? { line: t('ownServices.gate.lineNews'), button: { label: t('ownServices.gate.button'), onPress: () => router.push(OWN_ROUTES.plans as Href) } }
        : blocked
          ? { line: t('ownServices.onDevice.line'), button: { label: t('ownServices.onDevice.button'), onPress: () => router.navigate(OWN_ROUTES.onDevice as Href) } }
          : null;

    const check = async () => {
        if (!url || checking) return;
        setChecking(true);
        setError(null);
        try {
            await saveOwnNewsFields({ baseUrl: url, key: keyText });
            const r = await checkOwnNews({ baseUrl: url, key: keyText });
            await recordOwnNewsCheck(r.status, r.fields);
        } catch {
            // The stored item could not be written: the page keeps its last status. Nothing is logged, a key may be near.
        } finally {
            setChecking(false);
        }
    };

    const privacyVersion = useAcceptedPrivacyVersion();
    const toggle = async (next: boolean) => {
        setError(null);
        try {
            // Once per address, as on the AI page.
            if (next && cfg && !cfg.confirmed) {
                const confirmation = await confirmTurnOn({
                    title: t('ownServices.news.confirmTitle'),
                    body: t('ownServices.news.confirmBody'),
                    yes: t('ownServices.ai.confirmYes'),
                    cancel: t('common.cancel'),
                    privacyVersion,
                });
                if (!confirmation) return;
                await setOwnNewsOn(true, confirmation);
                return;
            }
            await setOwnNewsOn(next);
        } catch (e) {
            if (!(e instanceof OwnServiceError)) throw e;
            setError(
                e.code === 'address'
                    ? t(ADDRESS_ERROR_KEY[(e.reason as keyof typeof ADDRESS_ERROR_KEY) ?? 'invalid'] ?? ADDRESS_ERROR_KEY.invalid)
                    : e.code === 'gate'
                      ? t('ownServices.gate.lineNews')
                      : e.code === 'on-device'
                        ? t('ownServices.onDevice.line')
                        : t('ownServices.offUntilChecked'),
            );
        }
    };

    return {
        address, setAddress, key, setKey,
        addressError,
        canCheck: url != null && !checking,
        checkLabel: checking ? t('ownServices.checking') : status ? t('ownServices.checkAgain') : t('ownServices.check'),
        checking,
        check,
        statusLine,
        offLine,
        switchValue: on,
        switchDisabled: !on && (dirty || cfg?.status !== 'connected' || gated || blocked || paired),
        reason,
        error,
        toggle,
        // Offered once a check passed: before it nothing is known about the server.
        showMissing: !dirty && cfg?.status === 'connected' && (missing === null || missing.length > 0),
    };
}
