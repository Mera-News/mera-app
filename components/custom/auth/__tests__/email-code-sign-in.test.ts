const mockHold = jest.fn();
const mockRelease = jest.fn();
jest.mock('@/lib/security/identity-gate', () => ({
    holdAccountSwitch: (id: string) => mockHold(id),
    releaseAccountSwitch: () => mockRelease(),
}));
const mockDeleteItem = jest.fn(async (_key: string) => undefined);
jest.mock('@/lib/utils/secure-store-adapter', () => ({
    secureStore: { deleteItemAsync: (k: string) => mockDeleteItem(k) },
}));
jest.mock('expo-constants', () => ({ __esModule: true, default: { expoConfig: { slug: 'mera' } } }));
jest.mock('@/lib/auth-client', () => ({ authClient: {} }));
jest.mock('@/lib/logger', () => ({ __esModule: true, default: { captureException: jest.fn() } }));

import { signInWithEmailCode } from '../email-code-sign-in';

const ME = 'aaaaaaaaaaaaaaaaaaaaaaaa';
const OTHER = 'bbbbbbbbbbbbbbbbbbbbbbbb';
const ok = (id: string) => ({ data: { user: { id } }, error: null });
const err = (status: number, code: string) => ({ data: null, error: { status, code } });

beforeEach(() => jest.clearAllMocks());

describe('signInWithEmailCode', () => {
    it('a first sign-in sends no expectedUserId and accepts any account', async () => {
        const signIn = jest.fn(async () => ok(OTHER));
        await expect(signInWithEmailCode('a@b.c', '123456', null, { signIn })).resolves.toEqual({ kind: 'ok', userId: OTHER });
        expect(signIn).toHaveBeenCalledWith({ email: 'a@b.c', otp: '123456' });
    });

    it('the gate sends expectedUserId and accepts the same account', async () => {
        const signIn = jest.fn(async () => ok(ME));
        await expect(signInWithEmailCode('a@b.c', '1', ME, { signIn })).resolves.toEqual({ kind: 'ok', userId: ME });
        expect(signIn).toHaveBeenCalledWith({ email: 'a@b.c', otp: '1', expectedUserId: ME });
    });

    it('a different account is refused: signed out, its cookie deleted, nothing kept', async () => {
        const signOut = jest.fn(async () => undefined);
        const res = await signInWithEmailCode('a@b.c', '1', ME, { signIn: async () => ok(OTHER), signOut });
        expect(res).toEqual({ kind: 'mismatch' });
        expect(mockHold).toHaveBeenCalledWith(OTHER);
        expect(signOut).toHaveBeenCalled();
        expect(mockDeleteItem).toHaveBeenCalledWith('mera_cookie');
        expect(mockDeleteItem).toHaveBeenCalledWith('mera_session_data');
        expect(mockRelease).not.toHaveBeenCalled();
    });

    it('a failed sign-out still deletes the cookie', async () => {
        const signOut = jest.fn(async () => {
            throw new Error('offline');
        });
        await signInWithEmailCode('a@b.c', '1', ME, { signIn: async () => ok(OTHER), signOut });
        expect(mockDeleteItem).toHaveBeenCalledWith('mera_cookie');
    });

    it('the server refusal (409) is a mismatch', async () => {
        const res = await signInWithEmailCode('a@b.c', '1', ME, { signIn: async () => err(409, 'REAUTH_ACCOUNT_MISMATCH') });
        expect(res).toEqual({ kind: 'mismatch' });
    });

    it('a server that rejects the unknown field gets one retry without it', async () => {
        const signIn = jest.fn().mockResolvedValueOnce(err(400, 'VALIDATION_ERROR')).mockResolvedValueOnce(ok(OTHER));
        const res = await signInWithEmailCode('a@b.c', '1', ME, { signIn, signOut: async () => undefined });
        expect(signIn).toHaveBeenCalledTimes(2);
        expect(signIn).toHaveBeenLastCalledWith({ email: 'a@b.c', otp: '1' });
        // The client compare still refuses.
        expect(res).toEqual({ kind: 'mismatch' });
    });

    it('a wrong code is not retried', async () => {
        const signIn = jest.fn(async () => err(400, 'INVALID_OTP'));
        await expect(signInWithEmailCode('a@b.c', '1', ME, { signIn })).resolves.toEqual({ kind: 'wrong' });
        expect(signIn).toHaveBeenCalledTimes(1);
    });

    it('an id that is not an ObjectId is not sent, and the compare still applies', async () => {
        const signIn = jest.fn(async () => ok(OTHER));
        const res = await signInWithEmailCode('a@b.c', '1', 'not-an-id', { signIn, signOut: async () => undefined });
        expect(signIn).toHaveBeenCalledWith({ email: 'a@b.c', otp: '1' });
        expect(res).toEqual({ kind: 'mismatch' });
    });
});
