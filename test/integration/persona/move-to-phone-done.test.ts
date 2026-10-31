// A finished move offers nothing: the inbox row's action, the Settings row and the offer itself all
// ask `moveToPhoneDone()`, which trusts the server (no real email on the account) over the email
// row this device remembers. Owner bug on 1.3.5: a phone that had moved still opened the "Sign in
// with this phone instead" dialog from the inbox row. Real settings, notifications, dialog queue,
// auth client and MSW; the session the server reports is the only thing overridden.
import { act, render, renderHook } from '@testing-library/react-native';
import React from 'react';
import SupportIdCopy from '@/components/custom/config-mera/SupportIdCopy';
import { offerMoveToPhoneOnce, useMoveToPhoneFlow } from '@/components/custom/auth/MoveToPhoneHost';
import {
    __resetMoveToPhoneForTests,
    isMoveToPhoneVisible,
    moveToPhoneDone,
    requestMoveToPhone,
} from '@/components/custom/auth/move-to-phone';
import { tapNotification } from '@/components/custom/notifications/notification-actions';
import { getAll, notify } from '@/lib/database/services/notification-service';
import { deleteSetting, setSetting } from '@/lib/database/services/setting-service';
import { useDialogQueue } from '@/lib/dialog';
import { useUserStore } from '@/lib/stores/user-store';
import { ANON_EMAIL_DOMAIN } from '@/lib/subscription/email-capture';
import { FIXTURE_ACCOUNT, HttpResponse, http, initI18nEn, server, signInFixtureAccount, useFakeClock } from '@/test/helpers';

const ME = FIXTURE_ACCOUNT.userId;
const EMAIL = FIXTURE_ACCOUNT.email;
const ANON = `device-abc@${ANON_EMAIL_DOMAIN}`;

const moveRows = async () => (await getAll()).filter((n) => n.type === 'move_to_phone');

/** The server says the account has no real email any more: the move is done. */
const serverSaysMoved = () =>
    server.use(
        http.get('*/api/auth/get-session', () =>
            HttpResponse.json({
                session: { id: 's1', userId: ME, expiresAt: new Date(Date.now() + 86_400_000).toISOString() },
                user: { id: ME, email: ANON },
            }),
        ),
    );

/** The row 1.3.5 wrote before the move. */
const seedRow = () =>
    notify({
        type: 'move_to_phone',
        title: 'moveToPhone.inboxTitle',
        body: 'moveToPhone.inboxBody',
        context: { date: '30 October' },
        actions: [{ id: 'move-to-phone', labelKey: 'moveToPhone.settingsRow' }],
        source: 'move-to-phone',
    });

async function settle(ms = 300) {
    for (let spent = 0; spent < ms; spent += 20) {
        await act(async () => {
            await new Promise((r) => setTimeout(r, 20));
        });
    }
}

beforeAll(async () => {
    await initI18nEn();
});

beforeEach(async () => {
    useFakeClock(Date.now(), { advanceTimers: true });
    __resetMoveToPhoneForTests();
    useDialogQueue.setState({ queue: [] });
    await signInFixtureAccount();
    await setSetting('cached_user_id', ME);
    useUserStore.setState({ userId: ME });
});

describe('a phone whose move is done', () => {
    it('tapping the old inbox row shows no move dialog and deletes the row', async () => {
        // This phone moved: the move forgot the local email and the server holds the placeholder.
        await deleteSetting('cached_user_email');
        serverSaysMoved();
        const row = await seedRow();
        await renderHook(() => useMoveToPhoneFlow());

        await act(async () => {
            await tapNotification(row!);
        });
        await settle();

        expect(useDialogQueue.getState().queue).toHaveLength(0);
        expect(isMoveToPhoneVisible()).toBe(false);
        expect(await moveRows()).toHaveLength(0);
    });

    it('the server wins over a stale email row (the account moved on another phone)', async () => {
        await setSetting('cached_user_email', EMAIL);
        serverSaysMoved();
        await seedRow();
        await renderHook(() => useMoveToPhoneFlow());

        await act(async () => requestMoveToPhone());
        await settle();

        expect(useDialogQueue.getState().queue).toHaveLength(0);
        expect(await moveRows()).toHaveLength(0);
        await expect(moveToPhoneDone()).resolves.toBe(true);
    });

    it('is offered no row and no Settings entry', async () => {
        await setSetting('cached_user_email', EMAIL);
        serverSaysMoved();

        await offerMoveToPhoneOnce(ME);

        expect(await moveRows()).toHaveLength(0);
        // The Settings row shows only when this answers false.
        await expect(moveToPhoneDone()).resolves.toBe(true);
    });
});

// The Settings "!" beside a masked email opens the move: shown only while the move is not done.
describe('the Support ID line on an old email account with no Support ID', () => {
    const sessionWithEmail = (email: string) =>
        server.use(
            http.get('*/api/auth/get-session', () =>
                HttpResponse.json({
                    session: { id: 's1', userId: ME, expiresAt: new Date(Date.now() + 86_400_000).toISOString() },
                    user: { id: ME, email },
                }),
            ),
        );

    it('shows no move button once the move is done (a stale remembered email)', async () => {
        await setSetting('cached_user_email', EMAIL);
        useUserStore.setState({ userEmail: EMAIL });
        sessionWithEmail(ANON);
        const view = await render(React.createElement(SupportIdCopy, { testID: 'sid' }));
        await settle();

        expect(view.getByTestId('sid')).toBeTruthy();
        expect(view.queryByTestId('sid-move')).toBeNull();
    });

    it('shows the move button while the move is not done (control)', async () => {
        await setSetting('cached_user_email', EMAIL);
        useUserStore.setState({ userEmail: EMAIL });
        sessionWithEmail(EMAIL);
        const view = await render(React.createElement(SupportIdCopy, { testID: 'sid' }));
        await settle();

        expect(view.getByTestId('sid-move')).toBeTruthy();
    });
});

describe('a phone that has not moved (control)', () => {
    it('still gets the dialog, and the move check answers false', async () => {
        await setSetting('cached_user_email', EMAIL);
        await renderHook(() => useMoveToPhoneFlow());

        await act(async () => requestMoveToPhone());
        await settle();

        expect(useDialogQueue.getState().queue).toHaveLength(1);
        await expect(moveToPhoneDone()).resolves.toBe(false);
    });

    it('offline, the remembered email decides: not done', async () => {
        await setSetting('cached_user_email', EMAIL);
        server.use(http.get('*/api/auth/get-session', () => HttpResponse.error()));
        await expect(moveToPhoneDone()).resolves.toBe(false);
    });
});
