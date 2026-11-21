// The "Add to Mera News" link (mera.news/add/<publisherId>, meraapp://add/<publisherId>):
// held until the startup gate, then the publisher is preferred under every name, its page
// opens and Undo takes it back. Real writer and in-memory DB; only GraphQL is faked.
import { router } from 'expo-router';

import { redirectSystemPath } from '@/app/+native-intent';
import {
    __resetPendingAddSourceForTests,
    addSourceIdFromPath,
    openPendingAddSource,
} from '@/components/custom/publication-page/add-source-from-link';
import { getPreferenceKind, setPreferenceKind } from '@/lib/database/services/publication-preference-service';
import { resetPublisherSourceNames } from '@/lib/database/services/publisher-source-names';
import { usePinStore } from '@/lib/stores/pin-store';
import { __resetPendingNotificationRouteForTests, markStartupGatePassed } from '@/lib/stores/pending-notification-route';
import { toastManager } from '@/lib/toast-manager';
import { initI18nEn, mockGql, mockGqlError, server } from '@/test/helpers';
import { quietLogger, settleWrites } from '@/test/integration/data/services/persona/support';

const ID = '64b7f0c2a1b2c3d4e5f60718';
const NAMES = ['Le Monde', 'Le Monde International'];
const sources = (names: string[]) =>
    mockGql('PublicationSourcesForNewsPublisher', {
        publicationSourcesForNewsPublisher: { publicationSources: names.map((n, i) => ({ _id: `s${i}`, publication_name: n })) },
    });
const kinds = () => Promise.all(NAMES.map(getPreferenceKind));
const open = async () => {
    await openPendingAddSource(() => false);
    await settleWrites();
};

let logs: ReturnType<typeof quietLogger>;
let undoToast: jest.SpyInstance;
let infoToast: jest.SpyInstance;
beforeAll(initI18nEn);
beforeEach(() => {
    logs = quietLogger();
    resetPublisherSourceNames();
    __resetPendingAddSourceForTests();
    __resetPendingNotificationRouteForTests();
    usePinStore.setState({ locked: false });
    jest.mocked(router.push).mockClear();
    undoToast = jest.spyOn(toastManager, 'showUndoToast').mockImplementation(() => undefined);
    infoToast = jest.spyOn(toastManager, 'showInfo').mockImplementation(() => undefined);
});
afterEach(async () => {
    await settleWrites();
    undoToast.mockRestore();
    infoToast.mockRestore();
    logs.restore();
});

it('reads the id from every form the router hands over, and nothing else', () => {
    for (const path of [`https://mera.news/add/${ID}`, `meraapp://add/${ID}`, `meraapp:///add/${ID}`, `/add/${ID}`, `https://www.mera.news/add/${ID}/?x=1`]) {
        expect(addSourceIdFromPath(path)).toBe(ID);
    }
    for (const path of ['/add/abc', `/add/${ID}/more`, `https://evil.example/add/${ID}`, `/en/add/${ID}`, '/logged-in/app_container/feed']) {
        expect(addSourceIdFromPath(path)).toBeNull();
    }
});

it('a cold link waits for the gate, then prefers every name, opens the page and offers Undo', async () => {
    server.use(sources(NAMES));
    expect(redirectSystemPath({ path: `https://mera.news/add/${ID}`, initial: true })).toBe('/');
    await settleWrites();
    expect(await kinds()).toEqual(['none', 'none']);

    await open();
    expect(await kinds()).toEqual(['boost', 'boost']);
    expect(router.push).toHaveBeenCalledWith(expect.objectContaining({ params: expect.objectContaining({ publisherId: ID }) }));
    expect(undoToast).toHaveBeenCalledTimes(1);

    await undoToast.mock.calls[0][0].onUndo();
    await settleWrites();
    expect(await kinds()).toEqual(['none', 'none']);

    // Taken once: a second gate pass opens nothing.
    jest.mocked(router.push).mockClear();
    await open();
    expect(router.push).not.toHaveBeenCalled();
});

it('with the gate open, acts at once and routes to the page', async () => {
    server.use(sources(NAMES));
    markStartupGatePassed();
    expect(redirectSystemPath({ path: `meraapp://add/${ID}`, initial: false })).toBe(`/logged-in/publication?publisherId=${ID}`);
    await settleWrites();
    await settleWrites();
    expect(await kinds()).toEqual(['boost', 'boost']);
    expect(undoToast).toHaveBeenCalledTimes(1);
});

it('a malformed add link lands on the startup gate, never an unmatched route', () => {
    for (const path of ['meraapp://add/nothex', 'meraapp:///add/nothex', '/add', `https://mera.news/add/${ID}/more`]) {
        expect(redirectSystemPath({ path, initial: true })).toBe('/');
    }
    expect(redirectSystemPath({ path: '/logged-in/app_container/feed', initial: true })).toBe('/logged-in/app_container/feed');
});

it('under the PIN lock it still waits for the gate', async () => {
    markStartupGatePassed();
    usePinStore.setState({ locked: true });
    expect(redirectSystemPath({ path: `/add/${ID}`, initial: false })).toBe('/');
});

it('an already preferred publisher only opens its page', async () => {
    server.use(sources(NAMES));
    for (const n of NAMES) await setPreferenceKind(n, 'boost', 'user');
    redirectSystemPath({ path: `/add/${ID}`, initial: true });
    await open();
    expect(router.push).toHaveBeenCalledTimes(1);
    expect(undoToast).not.toHaveBeenCalled();
});

it('an unknown publisher or a failed lookup writes nothing and says so', async () => {
    server.use(mockGqlError('PublicationSourcesForNewsPublisher', 'INTERNAL_SERVER_ERROR'));
    redirectSystemPath({ path: `/add/${ID}`, initial: true });
    await open();
    expect(await kinds()).toEqual(['none', 'none']);
    expect(router.push).not.toHaveBeenCalled();
    expect(infoToast).toHaveBeenCalledWith("Couldn't add that publication. Find it in Sources instead.");
});
