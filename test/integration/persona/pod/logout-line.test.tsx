// The logout dialog's extra line: the paired line, the own-service line, or nothing.
import { act, renderHook } from '@testing-library/react-native';
import { useAppPreferences } from '@/components/custom/config-mera/useAppPreferences';
import { useDialogQueue } from '@/lib/dialog';
import { ownAiState } from '@/lib/own-services/own-ai-state';
import { ownNewsState } from '@/lib/own-services/own-news-state';
import { forgetPairing, podState, savePairing } from '@/lib/own-services/pod-state';
import { initI18nEn, podPairing } from '@/test/helpers';

const BODY = "Signing out erases everything stored on this device: your saved articles, reading history, tracked stories and personalization. You'll need to sign in again to use Mera.";
const PAIRED = 'This phone is also unpaired from your server.';
const OWN = 'Your own service settings are removed from this phone.';

const askLogout = async () => {
    const { result } = await renderHook(() => useAppPreferences());
    await act(async () => {
        void result.current.confirmLogout();
    });
    await act(async () => {
        for (let i = 0; i < 20 && useDialogQueue.getState().queue.length === 0; i++) await new Promise((r) => setImmediate(r));
    });
    const ask = useDialogQueue.getState().queue[0];
    useDialogQueue.setState({ queue: [] });
    return ask;
};

beforeAll(initI18nEn);
beforeEach(() => {
    podState.resetMemory();
    ownAiState.resetMemory();
    ownNewsState.resetMemory();
    useDialogQueue.setState({ queue: [] });
});
afterEach(() => forgetPairing());

describe('the logout dialog', () => {
    it('adds nothing when no own service and no server is stored', async () => {
        const ask = await askLogout();
        expect(ask.body).toBe(BODY);
    });

    it('says the phone is unpaired while paired', async () => {
        await savePairing(podPairing());
        const ask = await askLogout();
        expect(ask.body).toContain(BODY);
        expect(ask.body).toContain(PAIRED);
        expect(ask.body).not.toContain(OWN);
        expect(ask.destructive).toBe(true);
    });

    it('says the own service settings are removed while either has a stored item', async () => {
        await ownNewsState.save({ v: 1, baseUrl: 'https://news.own.test', key: null, on: false, checkedAt: 1, status: 'connected', fields: null, confirmed: null });
        const ask = await askLogout();
        expect(ask.body).toContain(OWN);
        expect(ask.body).not.toContain(PAIRED);
    });
});
