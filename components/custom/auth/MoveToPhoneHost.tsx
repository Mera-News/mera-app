// MoveToPhoneHost: the move to phone sign-in UI for email accounts. Renders
// nothing until asked. Three parts, all here because they share one state:
//   1. the one-time inbox offer (a Notifications row, once per account),
//   2. the confirm dialog (lib/dialog, never a native alert),
//   3. the full-screen progress modal that drives moveToPhone().
// The flow itself (restart hold, local cleanup) lives in move-to-phone.ts.
// Mounted once in app/logged-in/_layout.tsx.

import { Check, Circle, X } from 'lucide-react-native';
import { useCallback, useEffect, useRef, useState } from 'react';
import { AccessibilityInfo, ActivityIndicator, Modal, Platform, Pressable, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { GluestackUIProvider } from '@/components/ui/gluestack-ui-provider';
import { Text } from '@/components/ui/text';
import { getSetting, setSetting } from '@/lib/database/services/setting-service';
import { notify } from '@/lib/database/services/notification-service';
import { showDialog } from '@/lib/dialog';
import i18n from '@/lib/i18n';
import logger from '@/lib/logger';
import { useUserStore } from '@/lib/stores/user-store';
import { useColors } from '@/lib/theme/tokens';
import {
    emailCutoffLabel,
    isEmailAccount,
    moveToPhone,
    setMoveToPhoneVisible,
    subscribeMoveToPhone,
    type MoveStep,
} from './move-to-phone';

export const MOVE_TO_PHONE_OFFERED_KEY = 'move_to_phone_offered';
export const MOVE_TO_PHONE_ACTION_ID = 'move-to-phone';

/** Writes the one inbox row, once per account. Never throws. */
export async function offerMoveToPhoneOnce(userId: string): Promise<void> {
    try {
        if (!userId || (await getSetting(MOVE_TO_PHONE_OFFERED_KEY)) === userId) return;
        if (!(await isEmailAccount())) return;
        // Stamp first: a crash between the two must not write the row twice.
        await setSetting(MOVE_TO_PHONE_OFFERED_KEY, userId);
        await notify({
            type: 'move_to_phone',
            title: 'moveToPhone.inboxTitle',
            body: 'moveToPhone.inboxBody',
            context: { date: emailCutoffLabel(i18n.language) },
            actions: [{ id: MOVE_TO_PHONE_ACTION_ID, labelKey: 'moveToPhone.settingsRow' }],
            source: 'move-to-phone',
        });
    } catch (error) {
        logger.captureException(error, { tags: { component: 'MoveToPhoneHost', method: 'offer' } });
    }
}

const STEPS: MoveStep[] = ['checking', 'linking', 'removing', 'done'];

export type MoveView =
    | { kind: 'idle' }
    | { kind: 'running'; step: MoveStep }
    | { kind: 'moved' }
    | { kind: 'failed'; step: MoveStep }
    | { kind: 'unsupported' };

export type StepState = 'pending' | 'active' | 'done' | 'failed';

/** Per-step icon state. Linking and removing tick together when the call resolves. */
export function stepStates(view: MoveView): StepState[] {
    switch (view.kind) {
        case 'moved':
            return STEPS.map(() => 'done');
        case 'unsupported':
            return ['failed', 'pending', 'pending', 'pending'];
        case 'failed': {
            const at = STEPS.indexOf(view.step);
            return STEPS.map((_, i) => (i < at ? 'done' : i === at ? 'failed' : 'pending'));
        }
        case 'running': {
            const active = view.step === 'checking' ? 0 : 1;
            return STEPS.map((_, i) => (i < active ? 'done' : i === active ? 'active' : 'pending'));
        }
        default:
            return STEPS.map(() => 'pending');
    }
}

/** The flow's state machine: ask (dialog), run, retry, close. */
export function useMoveToPhoneFlow() {
    const [view, setView] = useState<MoveView>({ kind: 'idle' });
    const busy = useRef(false);

    const run = useCallback(async () => {
        setView({ kind: 'running', step: 'checking' });
        const outcome = await moveToPhone((step) => setView((v) => (v.kind === 'running' ? { kind: 'running', step } : v)));
        setView(outcome.kind === 'moved' ? { kind: 'moved' } : outcome.kind === 'unsupported' ? { kind: 'unsupported' } : outcome);
    }, []);

    const close = useCallback(() => {
        busy.current = false;
        setView({ kind: 'idle' });
        setMoveToPhoneVisible(false);
    }, []);

    const start = useCallback(async () => {
        if (busy.current) return;
        busy.current = true;
        setMoveToPhoneVisible(true);
        const date = emailCutoffLabel(i18n.language);
        const confirmed = await showDialog({
            title: i18n.t('moveToPhone.dialogTitle'),
            body: `${i18n.t('moveToPhone.dialogBody')}\n\n${i18n.t('moveToPhone.dialogSettingsHint', { date })}`,
            confirmLabel: i18n.t('moveToPhone.confirm'),
            cancelLabel: i18n.t('moveToPhone.cancel'),
        });
        if (!confirmed) return close();
        await run();
    }, [close, run]);

    useEffect(() => subscribeMoveToPhone(() => void start()), [start]);

    return { view, retry: run, close };
}

function StepIcon({ state }: { state: StepState }) {
    const c = useColors();
    if (state === 'active') return <ActivityIndicator color={c.accentMark} />;
    if (state === 'done') return <Check size={22} color={c.accentMark} />;
    if (state === 'failed') return <X size={22} color={c.ink} />;
    return <Circle size={22} color={c.ink3} />;
}

function ActionButton({ label, onPress, primary }: { label: string; onPress: () => void; primary?: boolean }) {
    const c = useColors();
    return (
        <Pressable
            accessibilityRole="button"
            onPress={onPress}
            style={{
                paddingVertical: 14,
                borderRadius: 14,
                alignItems: 'center',
                backgroundColor: primary ? c.accent : c.surface,
            }}
        >
            <Text style={{ color: primary ? c.onAccent : c.ink, fontWeight: '600' }}>{label}</Text>
        </Pressable>
    );
}

function Progress({ view, retry, close }: { view: MoveView; retry: () => void; close: () => void }) {
    const c = useColors();
    const insets = useSafeAreaInsets();
    const t = i18n.t.bind(i18n) as (k: string, o?: Record<string, unknown>) => string;
    const states = stepStates(view);
    const date = emailCutoffLabel(i18n.language);
    const message =
        view.kind === 'moved'
            ? t('moveToPhone.success')
            : view.kind === 'failed'
              ? t('moveToPhone.failed')
              : view.kind === 'unsupported'
                ? t(Platform.OS === 'ios' ? 'moveToPhone.unsupportedIos' : 'moveToPhone.unsupportedAndroid', { date })
                : null;

    // Announce each change of the step in progress (and the final outcome).
    const spoken = view.kind === 'running' ? t(`moveToPhone.steps.${view.step}`) : message;
    useEffect(() => {
        if (spoken) AccessibilityInfo.announceForAccessibility(spoken);
    }, [spoken]);

    return (
        <View style={{ flex: 1, backgroundColor: c.base, paddingTop: insets.top + 32, paddingBottom: insets.bottom + 24, paddingHorizontal: 24 }}>
            <Text accessibilityRole="header" style={{ color: c.ink, fontSize: 24, fontWeight: '700', marginBottom: 32 }}>
                {t('moveToPhone.progressTitle')}
            </Text>
            {STEPS.map((step, i) => (
                <View key={step} accessible style={{ flexDirection: 'row', alignItems: 'center', gap: 14, marginBottom: 20 }}>
                    <StepIcon state={states[i]} />
                    <Text style={{ color: states[i] === 'pending' ? c.ink3 : c.ink, fontSize: 17 }}>{t(`moveToPhone.steps.${step}`)}</Text>
                </View>
            ))}
            {message ? <Text style={{ color: c.ink2, fontSize: 16, marginTop: 8 }}>{message}</Text> : null}
            <View style={{ flex: 1 }} />
            {view.kind === 'moved' ? <ActionButton primary label={t('common.done')} onPress={close} /> : null}
            {view.kind === 'failed' ? (
                <View style={{ gap: 10 }}>
                    <ActionButton primary label={t('auth.tryAgain')} onPress={retry} />
                    <ActionButton label={t('moveToPhone.close')} onPress={close} />
                </View>
            ) : null}
            {view.kind === 'unsupported' ? <ActionButton label={t('moveToPhone.close')} onPress={close} /> : null}
        </View>
    );
}

export default function MoveToPhoneHost() {
    const userId = useUserStore((s) => s.userId);
    const { view, retry, close } = useMoveToPhoneFlow();

    useEffect(() => {
        if (userId) void offerMoveToPhoneOnce(userId);
    }, [userId]);

    const open = view.kind !== 'idle';
    return (
        <Modal
            visible={open}
            animationType="none"
            presentationStyle="fullScreen"
            // Android back and the iOS swipe can't dismiss while it runs.
            onRequestClose={view.kind === 'running' ? () => undefined : close}
        >
            <GluestackUIProvider>{open ? <Progress view={view} retry={() => void retry()} close={close} /> : null}</GluestackUIProvider>
        </Modal>
    );
}
