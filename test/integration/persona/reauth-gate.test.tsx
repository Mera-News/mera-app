// The sign-in gate as /login renders it: the real route, AuthScreen and useAuthScreen over the
// in-memory DB. Which way out the gate offers depends on the reauth param and on the device.
import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { useLocalSearchParams } from 'expo-router';
import LoginScreen from '@/app/login';
import { setSetting } from '@/lib/database/services/setting-service';
import { HttpResponse, http, initI18nEn, server, signInFixtureAccount } from '@/test/helpers';

jest.mock('react-native/Libraries/Modal/Modal', () => {
    const { View } = jest.requireActual('react-native');
    return {
        __esModule: true,
        default: ({ visible, children }: { visible?: boolean; children?: React.ReactNode }) =>
            visible ? <View>{children}</View> : null,
    };
});

jest.mock('@/components/ui/gluestack-ui-provider', () => ({
    GluestackUIProvider: ({ children }: { children?: React.ReactNode }) => children,
}));

jest.mock('@/components/custom/auth/LaunchLogo', () => ({ __esModule: true, default: () => null }));
jest.mock('@/components/custom/AbstractGradientBackdrop', () => ({ __esModule: true, default: () => null }));

const mockIsSupported = jest.fn();
jest.mock('@/modules/mera-device-attest', () => ({
    ...jest.requireActual('@/modules/mera-device-attest'),
    isSupported: () => mockIsSupported(),
}));

const SIGN_IN = 'reauth-sign-in';
const RESET = 'reauth-reset-phone';

async function openGate(reauth: string) {
    jest.mocked(useLocalSearchParams).mockReturnValue({ reauth });
    await render(<LoginScreen />);
    await screen.findByTestId(RESET, undefined, { timeout: 3000 });
}

beforeAll(initI18nEn);

beforeEach(async () => {
    mockIsSupported.mockReset().mockResolvedValue(true);
    await signInFixtureAccount();
    await setSetting('cached_user_id', 'cached-account');
});

it('a dead session gets a sign-in button above Reset this phone', async () => {
    await openGate('1');

    const buttons = screen.getAllByRole('button').map((b) => b.props.testID);
    expect(buttons.indexOf(SIGN_IN)).toBeGreaterThanOrEqual(0);
    expect(buttons.indexOf(SIGN_IN)).toBeLessThan(buttons.indexOf(RESET));
});

it('the sign-in button goes to consent, and back returns to the gate', async () => {
    await openGate('1');

    await fireEvent.press(screen.getByTestId(SIGN_IN));
    await screen.findByTestId('auth-consent');

    await fireEvent.press(screen.getByTestId('auth-back'));
    await waitFor(() => expect(screen.getByTestId(RESET)).toBeTruthy());
});

it('Forgot PIN hides the sign-in button and makes no device sign-in', async () => {
    const posts: unknown[] = [];
    server.use(http.post('*/api/auth/device/sign-in/:platform', () => void posts.push(1)));

    await openGate('pin');

    expect(screen.queryByTestId(SIGN_IN)).toBeNull();
    expect(screen.getByText(/reset this phone and sign in again\.$/)).toBeTruthy();
    expect(posts).toEqual([]);
});

it('a phone that cannot attest gets no sign-in button', async () => {
    mockIsSupported.mockResolvedValue(false);

    await openGate('1');

    expect(screen.queryByTestId(SIGN_IN)).toBeNull();
});

it('an unbound key mints nothing from the gate and points to support or reset', async () => {
    process.env.EXPO_PUBLIC_DEVICE_ATTEST_DEV_TOKEN = 'dev-token';
    const bodies: unknown[] = [];
    server.use(
        http.post('*/api/auth/device/sign-in/dev', async ({ request }) => {
            bodies.push(await request.clone().json());
            return HttpResponse.json({ code: 'DEVICE_NOT_BOUND', message: 'x' }, { status: 409 });
        }),
    );
    await openGate('1');

    await fireEvent.press(screen.getByTestId(SIGN_IN));
    await fireEvent.press(await screen.findByTestId('auth-consent-agree'));

    expect((await screen.findByTestId('auth-device-failure')).props.children).toBe(
        "This phone isn't linked to your account. Go back to contact support or reset this phone.",
    );
    expect(bodies).toEqual([expect.objectContaining({ resumeOnly: true })]);
    expect(screen.queryByTestId('auth-device-retry')).toBeNull();
    delete process.env.EXPO_PUBLIC_DEVICE_ATTEST_DEV_TOKEN;
});
