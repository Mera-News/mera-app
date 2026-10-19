// The move to phone UI (components/custom/auth/MoveToPhoneHost.tsx): the one-time inbox offer, the
// confirm dialog and the progress state machine over the real moveToPhone and device sign-in client
// (the mock auth service answers /device/convert), the inbox row's action, and the feedback auto-show
// host staying quiet while the move UI is up. Real settings, notifications, dialog queue, user store.
// Edges only: the attestation SDK wrapper and ANDROID_ID, as in move-to-phone.test.ts.
import { act, renderHook } from '@testing-library/react-native';
import { router, usePathname } from 'expo-router';
import { Platform } from 'react-native';
import FeedbackRequestAutoShowHost from '@/components/custom/feedback-request/FeedbackRequestAutoShowHost';
import {
    MOVE_TO_PHONE_OFFERED_KEY,
    offerMoveToPhoneOnce,
    stepStates,
    useMoveToPhoneFlow,
} from '@/components/custom/auth/MoveToPhoneHost';
import {
    __resetMoveToPhoneForTests,
    isMoveToPhoneVisible,
    requestMoveToPhone,
} from '@/components/custom/auth/move-to-phone';
import { tapNotification } from '@/components/custom/notifications/notification-actions';
import { getAll } from '@/lib/database/services/notification-service';
import { ANON_EMAIL_DOMAIN } from '@/lib/subscription/email-capture';
import { getSetting, setSetting } from '@/lib/database/services/setting-service';
import { settleDialog, useDialogQueue } from '@/lib/dialog';
import { __resetFeedbackRequestStateForTests, updateFeedbackRequestsState } from '@/lib/feedback-requests/feedback-request-state';
import { markStartupGatePassed } from '@/lib/stores/pending-notification-route';
import { useUserStore } from '@/lib/stores/user-store';
import { __resetDeviceAttestForTests } from '@/modules/mera-device-attest';
import { FIXTURE_ACCOUNT, HttpResponse, http, initI18nEn, server, signInFixtureAccount } from '@/test/helpers';
import { t } from 'i18next';

const mockAttest = {
    isSupported: jest.fn(),
    generateKey: jest.fn(),
    attestKey: jest.fn(),
    generateAssertion: jest.fn(),
    requestIntegrityToken: jest.fn(),
};
jest.mock('@/modules/mera-device-attest', () => ({
    ...jest.requireActual('@/modules/mera-device-attest'),
    isSupported: (...a: unknown[]) => mockAttest.isSupported(...a),
    generateKey: (...a: unknown[]) => mockAttest.generateKey(...a),
    attestKey: (...a: unknown[]) => mockAttest.attestKey(...a),
    generateAssertion: (...a: unknown[]) => mockAttest.generateAssertion(...a),
    requestIntegrityToken: (...a: unknown[]) => mockAttest.requestIntegrityToken(...a),
}));
jest.mock('expo-application', () => ({ getAndroidId: () => 'android-hw-1' }));

const ME = FIXTURE_ACCOUNT.userId;
const EMAIL = FIXTURE_ACCOUNT.email;
const CONVERT = '*/api/auth/device/convert';
const nav = router as unknown as { push: jest.Mock };

function convertAnswers(...answers: (() => Response)[]) {
    let call = 0;
    server.use(http.post(CONVERT, () => answers[Math.min(call++, answers.length - 1)]()));
}
const ok = (status: string) => () => HttpResponse.json({ status, supportId: '1234567' });
const fail = (status: number, code: string) => () => HttpResponse.json({ code, message: code }, { status });

const moveRows = async () => (await getAll()).filter((n) => n.type === 'move_to_phone');

/** Answers the front dialog the way the dialog host does. */
async function answerDialog(confirmed: boolean) {
    await waitFor(() => useDialogQueue.getState().queue.length > 0);
    const front = useDialogQueue.getState().queue[0];
    await act(async () => settleDialog(front.id, confirmed));
    return front;
}

async function waitFor(check: () => boolean, ms = 4000) {
    for (let spent = 0; spent < ms; spent += 20) {
        if (check()) return;
        await act(async () => {
            await new Promise((r) => setTimeout(r, 20));
        });
    }
    throw new Error('condition never held');
}

beforeAll(async () => {
    await initI18nEn();
});

beforeEach(async () => {
    __resetMoveToPhoneForTests();
    __resetDeviceAttestForTests();
    useDialogQueue.setState({ queue: [] });
    (Platform as { OS: string }).OS = 'ios';
    delete process.env.EXPO_PUBLIC_DEVICE_ATTEST_DEV_TOKEN;
    mockAttest.isSupported.mockReset().mockResolvedValue(true);
    mockAttest.generateKey.mockReset().mockResolvedValue('key-1');
    mockAttest.attestKey.mockReset().mockResolvedValue('attestation-b64');
    mockAttest.generateAssertion.mockReset().mockResolvedValue('assertion-b64');
    mockAttest.requestIntegrityToken.mockReset().mockResolvedValue('integrity-token');
    await signInFixtureAccount();
    await setSetting('cached_user_id', ME);
    await setSetting('cached_user_email', EMAIL);
    useUserStore.setState({ userId: ME, userEmail: EMAIL });
});

afterEach(() => {
    (Platform as { OS: string }).OS = 'ios';
});

describe('the inbox offer', () => {
    it('writes one row for an email account, once, with the date and the move action', async () => {
        await offerMoveToPhoneOnce(ME);
        await offerMoveToPhoneOnce(ME);

        const rows = await moveRows();
        expect(rows).toHaveLength(1);
        expect(rows[0].title).toBe('moveToPhone.inboxTitle');
        expect(rows[0].body).toBe('moveToPhone.inboxBody');
        expect(JSON.parse(rows[0].contextJson!)).toEqual({ date: expect.any(String) });
        expect(JSON.parse(rows[0].actionsJson!)).toEqual([{ id: 'move-to-phone', labelKey: 'moveToPhone.settingsRow' }]);
        await expect(getSetting(MOVE_TO_PHONE_OFFERED_KEY)).resolves.toBe(ME);
    });

    it('never writes for a phone account', async () => {
        await setSetting('cached_user_email', `device-abc@${ANON_EMAIL_DOMAIN}`);
        server.use(
            http.get('*/api/auth/get-session', () =>
                HttpResponse.json({ session: { userId: ME }, user: { id: ME, email: `device-abc@${ANON_EMAIL_DOMAIN}` } }),
            ),
        );

        await offerMoveToPhoneOnce(ME);

        expect(await moveRows()).toHaveLength(0);
        await expect(getSetting(MOVE_TO_PHONE_OFFERED_KEY)).resolves.toBeNull();
    });

    it('a second account on the same device is offered again', async () => {
        await offerMoveToPhoneOnce('someone-else');
        await offerMoveToPhoneOnce(ME);
        expect(await moveRows()).toHaveLength(2);
    });

    it('tapping the row asks for the move', async () => {
        await offerMoveToPhoneOnce(ME);
        const [row] = await moveRows();
        const { result } = renderHook(() => useMoveToPhoneFlow());

        await act(async () => {
            await tapNotification(row);
        });
        const dialog = await answerDialog(false);

        expect(dialog.title).toBe(t('moveToPhone.dialogTitle'));
        expect(result.current.view).toEqual({ kind: 'idle' });
    });
});

describe('the flow', () => {
    it('shows the dialog with the settings hint, then moves and ends moved', async () => {
        convertAnswers(ok('converted'));
        const { result } = renderHook(() => useMoveToPhoneFlow());

        act(() => requestMoveToPhone());
        await waitFor(() => useDialogQueue.getState().queue.length > 0);
        expect(isMoveToPhoneVisible()).toBe(true);
        const dialog = useDialogQueue.getState().queue[0];
        expect(dialog.body).toContain(t('moveToPhone.dialogBody'));
        expect(dialog.body).toContain('\n\n');
        expect(dialog.body).not.toContain('{{date}}');
        expect(dialog.confirmLabel).toBe(t('moveToPhone.confirm'));
        expect(dialog.cancelLabel).toBe(t('moveToPhone.cancel'));

        await answerDialog(true);
        await waitFor(() => result.current.view.kind === 'moved');

        expect(stepStates(result.current.view)).toEqual(['done', 'done', 'done', 'done']);
        await expect(getSetting('cached_user_email')).resolves.toBeNull();
        act(() => result.current.close());
        expect(result.current.view).toEqual({ kind: 'idle' });
        expect(isMoveToPhoneVisible()).toBe(false);
    });

    it('Not now changes nothing and clears the visibility', async () => {
        const { result } = renderHook(() => useMoveToPhoneFlow());

        act(() => requestMoveToPhone());
        await answerDialog(false);
        await waitFor(() => !isMoveToPhoneVisible());

        expect(result.current.view).toEqual({ kind: 'idle' });
        await expect(getSetting('cached_user_email')).resolves.toBe(EMAIL);
    });

    it('a failed move shows the cross on the failed step, and Try again reruns it to success', async () => {
        convertAnswers(fail(503, 'DEVICE_ATTESTATION_UNAVAILABLE'), ok('converted'));
        const { result } = renderHook(() => useMoveToPhoneFlow());

        act(() => requestMoveToPhone());
        await answerDialog(true);
        await waitFor(() => result.current.view.kind === 'failed');

        expect(result.current.view).toEqual({ kind: 'failed', step: 'linking' });
        expect(stepStates(result.current.view)).toEqual(['done', 'failed', 'pending', 'pending']);
        await expect(getSetting('cached_user_email')).resolves.toBe(EMAIL);

        await act(async () => {
            await result.current.retry();
        });
        expect(result.current.view).toEqual({ kind: 'moved' });
        await expect(getSetting('cached_user_email')).resolves.toBeNull();
    });

    it('an unsupported phone crosses out checking and offers only Close', async () => {
        mockAttest.isSupported.mockResolvedValue(false);
        const { result } = renderHook(() => useMoveToPhoneFlow());

        act(() => requestMoveToPhone());
        await answerDialog(true);
        await waitFor(() => result.current.view.kind === 'unsupported');

        expect(stepStates(result.current.view)).toEqual(['failed', 'pending', 'pending', 'pending']);
        act(() => result.current.close());
        expect(isMoveToPhoneVisible()).toBe(false);
    });

    it('a second request while one is open is ignored', async () => {
        const { result } = renderHook(() => useMoveToPhoneFlow());

        act(() => requestMoveToPhone());
        await waitFor(() => useDialogQueue.getState().queue.length > 0);
        act(() => requestMoveToPhone());

        expect(useDialogQueue.getState().queue).toHaveLength(1);
        await answerDialog(false);
        await waitFor(() => !isMoveToPhoneVisible());
        expect(result.current.view.kind).toBe('idle');
    });
});

describe('stepStates while running', () => {
    it('checking is active first; linking and removing share one active step until the call resolves', () => {
        expect(stepStates({ kind: 'running', step: 'checking' })).toEqual(['active', 'pending', 'pending', 'pending']);
        expect(stepStates({ kind: 'running', step: 'linking' })).toEqual(['done', 'active', 'pending', 'pending']);
        expect(stepStates({ kind: 'running', step: 'removing' })).toEqual(['done', 'active', 'pending', 'pending']);
    });
});

jest.setTimeout(15000);

describe('FeedbackRequestAutoShowHost', () => {
    const ID = 'a'.repeat(24);

    beforeEach(async () => {
        jest.mocked(usePathname).mockReturnValue('/logged-in/app_container/feed');
        markStartupGatePassed();
        __resetFeedbackRequestStateForTests();
        nav.push.mockClear();
        await updateFeedbackRequestsState((s) => {
            s[ID] = { question: 'How is Mera?', endsAt: Date.now() + 3_600_000 };
        });
    });

    it('shows a live request when the move UI is closed (control)', async () => {
        renderHook(() => FeedbackRequestAutoShowHost());
        await waitFor(() => nav.push.mock.calls.length > 0, 6000);
        expect(nav.push).toHaveBeenCalledWith({ pathname: '/logged-in/feedback-request', params: { id: ID } });
    });

    it('stays quiet, and leaves the request unshown, while the move UI is visible', async () => {
        const { result } = renderHook(() => useMoveToPhoneFlow());
        act(() => requestMoveToPhone());
        await waitFor(() => useDialogQueue.getState().queue.length > 0);

        renderHook(() => FeedbackRequestAutoShowHost());
        await act(async () => {
            await new Promise((r) => setTimeout(r, 2500));
        });

        expect(nav.push).not.toHaveBeenCalled();
        await answerDialog(false);
        expect(result.current.view.kind).toBe('idle');
    });
});
