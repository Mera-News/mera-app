// A star on a server that cannot list a publication's names writes under the names this phone knows; Mera still refuses.
import { act, renderHook } from '@testing-library/react-native';

import { usePublicationRowPrefs, type RowPublisher } from '@/components/custom/publication-preferences/use-publication-row-prefs';
import { resetPublisherSourceNames } from '@/lib/database/services/publisher-source-names';
import { getPreferenceKind } from '@/lib/database/services/publication-preference-service';
import client from '@/lib/apollo-client';
import { clearLatch } from '@/lib/own-services/news-latch';
import { ownNewsState, recordOwnNewsCheck, saveOwnNewsFields, setOwnNewsOn } from '@/lib/own-services/own-news-state';
import { toastManager } from '@/lib/toast-manager';
import { http, HttpResponse, initI18nEn, mockGqlError, server } from '@/test/helpers';
import { quietLogger, settleWrites } from '@/test/integration/data/services/persona/support';

const HIT: RowPublisher = { publisherId: 'pub-1', rawName: 'Der Spiegel', countryCode: 'DEU' };
const OTHER_NAME = 'Spiegel Wirtschaft';
const FEED = ['articleIdsForPersona', 'articlesForTopicsByIds'];
const OWN = 'https://news.own.test/graphql';

const validationFailure = () =>
    HttpResponse.json(
        { errors: [{ message: 'Cannot query field', extensions: { code: 'GRAPHQL_VALIDATION_FAILED' } }] },
        { status: 400, headers: { 'content-type': 'application/graphql-response+json' } },
    );
const ownAnswers = (respond: () => Response) =>
    http.post(OWN, async ({ request }) => {
        const body = (await request.clone().json().catch(() => ({}))) as { operationName?: string };
        return body.operationName === 'PublicationSourcesForNewsPublisher' ? respond() : undefined;
    });
const turnOn = async (fields: string[] | null) => {
    await saveOwnNewsFields({ baseUrl: 'https://news.own.test', key: 'own-news-key-12345678' });
    await recordOwnNewsCheck('connected', fields);
    await setOwnNewsOn(true, { at: 1, privacyVersion: null });
};
const starIt = async () => {
    const { result } = await renderHook(() => usePublicationRowPrefs());
    await act(async () => {
        result.current.publisherRow(HIT).onStar();
    });
    await settleWrites();
};

let logs: ReturnType<typeof quietLogger>;
let infoToast: jest.SpyInstance;
beforeAll(initI18nEn);
beforeEach(async () => {
    logs = quietLogger();
    resetPublisherSourceNames();
    ownNewsState.resetMemory();
    clearLatch();
    await client.clearStore();
    infoToast = jest.spyOn(toastManager, 'showInfo').mockImplementation(() => undefined);
});
afterEach(async () => {
    await settleWrites();
    infoToast.mockRestore();
    logs.restore();
});

it('own server rejects the names query: the star writes under the known names and shows no save error', async () => {
    await turnOn(null);
    server.use(ownAnswers(validationFailure));

    await starIt();

    expect(await getPreferenceKind(HIT.rawName)).toBe('boost');
    expect(await getPreferenceKind(OTHER_NAME)).toBe('none');
    expect(infoToast).not.toHaveBeenCalled();
});

it('own server whose listed fields lack the names query: the same narrower write, with no latch needed', async () => {
    await turnOn(FEED);
    server.use(ownAnswers(() => new HttpResponse('nope', { status: 404 })));

    await starIt();

    expect(await getPreferenceKind(HIT.rawName)).toBe('boost');
    expect(infoToast).not.toHaveBeenCalled();
});

it('own server that lists the names query but fails it: the write is still refused', async () => {
    await turnOn([...FEED, 'publicationSourcesForNewsPublisher']);
    server.use(ownAnswers(() => new HttpResponse('nope', { status: 404 })));

    await starIt();

    expect(await getPreferenceKind(HIT.rawName)).toBe('none');
    expect(infoToast).toHaveBeenCalledWith("Couldn't save that. Try again.");
});

it('mode off and Mera failing the same way: still refused, as today', async () => {
    server.use(mockGqlError('PublicationSourcesForNewsPublisher', 'GRAPHQL_VALIDATION_FAILED'));

    await starIt();

    expect(await getPreferenceKind(HIT.rawName)).toBe('none');
    expect(infoToast).toHaveBeenCalledWith("Couldn't save that. Try again.");
});
