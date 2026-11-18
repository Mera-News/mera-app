import { parseServiceAddress } from '@/lib/own-services/address';
import { checkOwnAi } from '@/lib/own-services/check-ai';
import { OwnServiceError, ownServicesAllowed } from '@/lib/own-services/gate';
import { ownAiState, recordOwnAiCheck, saveOwnAiFields, setOwnAiOn } from '@/lib/own-services/own-ai-state';
import { useRestartHold } from '@/lib/app-restart';
import { showDialog } from '@/lib/dialog';
import { useIsOnDeviceProcessing } from '@/lib/stores/mera-protocol-store';
import { router, type Href } from 'expo-router';
import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ADDRESS_ERROR_KEY, AI_STATUS_KEY, OWN_ROUTES } from './own-services-copy';

/** The page's state. Call it once the stored config is read in: the fields start from it. */
export function useOwnAiService() {
    const { t } = useTranslation();
    const cfg = ownAiState.useStore((s) => s.value);
    const onDevice = useIsOnDeviceProcessing();
    const [address, setAddress] = useState(cfg?.baseUrl ?? '');
    const [model, setModel] = useState(cfg?.model ?? '');
    const [key, setKey] = useState(cfg?.key ?? '');
    const [checking, setChecking] = useState(false);
    const [error, setError] = useState<string | null>(null);
    // The address the person has already accepted the no-confidential-computing warning for.
    const confirmedFor = useRef<string | null>(cfg?.on ? cfg.baseUrl : null);

    const trimmed = address.trim();
    const parsed = trimmed ? parseServiceAddress(trimmed) : null;
    const url = parsed?.ok ? parsed.url : null;
    const addressError = parsed && !parsed.ok ? t(ADDRESS_ERROR_KEY[parsed.reason]) : null;
    const modelText = model.trim();
    const keyText = key.trim() || null;
    const dirty = (url ?? trimmed) !== (cfg?.baseUrl ?? '') || modelText !== (cfg?.model ?? '') || keyText !== (cfg?.key ?? null);
    const on = cfg?.on === true;

    useRestartHold(dirty, 'draft:own-ai', 'hard');
    // Typing never moves the profile: the stored service stays in use until Check saves the new fields,
    // and that save turns the switch off (the state module's rule), so the person turns it back on knowingly.

    const status = !dirty && !checking ? (cfg?.status ?? null) : null;
    const reasonText = status && status !== 'connected' ? t(AI_STATUS_KEY[status]) : null;
    const statusLine = status
        ? status === 'connected'
            ? { ok: true, text: t(AI_STATUS_KEY.connected) }
            : { ok: false, text: on ? t('ownServices.lastCheckFailed', { reason: reasonText }) : (reasonText ?? '') }
        : null;
    const filled = url != null && modelText !== '';
    const offLine = !on && filled && !status && !checking ? t('ownServices.offUntilChecked') : null;

    const gated = !on && !ownServicesAllowed();
    const blocked = !on && onDevice;
    const reason = gated
        ? { line: t('ownServices.gate.line'), button: { label: t('ownServices.gate.button'), onPress: () => router.push(OWN_ROUTES.plans as Href) } }
        : blocked
          ? { line: t('ownServices.onDevice.line'), button: { label: t('ownServices.onDevice.button'), onPress: () => router.navigate(OWN_ROUTES.onDevice as Href) } }
          : null;

    const check = async () => {
        if (!url || modelText === '' || checking) return;
        setChecking(true);
        setError(null);
        try {
            await saveOwnAiFields({ baseUrl: url, model: modelText, key: keyText });
            await recordOwnAiCheck(await checkOwnAi({ baseUrl: url, model: modelText, key: keyText }));
        } catch {
            // The stored item could not be written: the page keeps its last status. Nothing is logged, a key may be near.
        } finally {
            setChecking(false);
        }
    };

    const errorLine = (e: OwnServiceError): string =>
        e.code === 'address'
            ? t(ADDRESS_ERROR_KEY[(e.reason as keyof typeof ADDRESS_ERROR_KEY) ?? 'invalid'] ?? ADDRESS_ERROR_KEY.invalid)
            : e.code === 'gate'
              ? t('ownServices.gate.line')
              : e.code === 'on-device'
                ? t('ownServices.onDevice.line')
                : t('ownServices.offUntilChecked');

    const toggle = async (next: boolean) => {
        setError(null);
        try {
            if (next && cfg && confirmedFor.current !== cfg.baseUrl) {
                const yes = await showDialog({
                    title: t('ownServices.ai.confirmTitle'),
                    body: t('ownServices.ai.warning'),
                    confirmLabel: t('ownServices.ai.confirmYes'),
                    cancelLabel: t('common.cancel'),
                });
                if (!yes) return;
                confirmedFor.current = cfg.baseUrl;
            }
            await setOwnAiOn(next);
        } catch (e) {
            if (!(e instanceof OwnServiceError)) throw e;
            setError(errorLine(e));
        }
    };

    return {
        address, setAddress, model, setModel, key, setKey,
        addressError,
        checking,
        canCheck: url != null && modelText !== '' && !checking,
        checkLabel: checking ? t('ownServices.checking') : status ? t('ownServices.checkAgain') : t('ownServices.check'),
        check,
        statusLine,
        offLine,
        switchValue: on,
        switchDisabled: !on && (dirty || cfg?.status !== 'connected' || gated || blocked),
        reason,
        error,
        toggle,
    };
}
