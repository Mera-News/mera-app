// ReauthOnReturn at its seams: the real breaker, the real auth client against the mock backend, the
// AppState fake. A return with the persisted dead verdict asks the server before it sends anyone to
// sign in, so a wrong verdict (a locked keychain, a blip) never strands a live account at the gate.
import { renderHook, waitFor } from '@testing-library/react-native';
import { router, usePathname } from 'expo-router';
import ReauthOnReturn from '@/components/custom/auth/ReauthOnReturn';
import { _resetForTests as resetAuthBreaker } from '@/lib/auth-failure-breaker';
import { useUserStore } from '@/lib/stores/user-store';
import { HttpResponse, http, server, setAppState, signInFixtureAccount } from '@/test/helpers';

const REAUTH = { pathname: '/login', params: { reauth: '1' } };
const recheck = (reply: () => Response) =>
    http.get('*/api/auth/get-session', ({ request }) =>
        new URL(request.url).searchParams.has('disableCookieCache') ? reply() : undefined,
    );

async function returnToApp(): Promise<void> {
    setAppState('background');
    setAppState('active');
    await new Promise((resolve) => setTimeout(resolve, 200));
}

beforeEach(async () => {
    resetAuthBreaker();
    jest.mocked(router.replace).mockClear();
    jest.mocked(usePathname).mockReturnValue('/logged-in/app_container/world');
    setAppState('active');
    await signInFixtureAccount();
    useUserStore.setState({ needsReauth: true });
});

it('a flagged session the server confirms dead goes to the sign-in gate on the return', async () => {
    server.use(recheck(() => HttpResponse.json(null)));
    renderHook(() => ReauthOnReturn());

    await returnToApp();

    await waitFor(() => expect(jest.mocked(router.replace).mock.calls).toEqual([[REAUTH]]));
});

it('a flagged session the server finds alive stays in the app and loses the flag', async () => {
    renderHook(() => ReauthOnReturn());

    await returnToApp();

    await waitFor(() => expect(useUserStore.getState().needsReauth).toBe(false));
    expect(router.replace).not.toHaveBeenCalled();
});
