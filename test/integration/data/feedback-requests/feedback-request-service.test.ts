// Seam test for the two GraphQL calls behind feedback requests: the real Apollo client and error
// link against MSW. Outcomes are what the modal and the sync task can observe.
import { crumbMessages, opsNamed, recordOps, resetNetworkAndBanner, banner, setDeviceLink, settleRecorder, spyLogger, view, serverList, failOp, A } from './support';
import {
    FEEDBACK_REQUEST_CLOSED,
    FEEDBACK_RESPONSE_MAX_CHARS,
    fetchActiveFeedbackRequests,
    submitFeedbackResponse,
} from '@/lib/feedback-requests/feedback-request-service';
import { mockGql, mockGqlError, server } from '@/test/helpers';

beforeEach(resetNetworkAndBanner);

const submitted = (over: Record<string, unknown> = {}) =>
    mockGql('SubmitFeedbackResponse', {
        submitFeedbackResponse: { __typename: 'SubmitFeedbackResponseResult', ok: true, alreadyAnswered: false, ...over },
    });

describe('fetchActiveFeedbackRequests', () => {
    // The server silently falls back to English for a code outside its list.
    it.each([
        ['en', 'en'],
        ['fr', 'fr'],
        ['pt', 'pt-BR'],
        ['zh-Hans', 'zh-CN'],
        ['zh-Hant', 'zh-TW'],
    ])('sends the server locale for app language %s: %s', async (appLanguage, locale) => {
        const sent = recordOps();
        await fetchActiveFeedbackRequests(appLanguage);
        await settleRecorder();
        expect(opsNamed(sent, 'ActiveFeedbackRequests').map((s) => s.variables)).toEqual([{ locale }]);
    });

    it('sends the locale only, never a user id', async () => {
        const sent = recordOps();
        await fetchActiveFeedbackRequests('en');
        await settleRecorder();
        expect(Object.keys(opsNamed(sent, 'ActiveFeedbackRequests')[0].variables)).toEqual(['locale']);
    });

    it('is no-cache: two calls reach the server twice', async () => {
        const sent = recordOps();
        await fetchActiveFeedbackRequests('en');
        await fetchActiveFeedbackRequests('en');
        await settleRecorder();
        expect(opsNamed(sent, 'ActiveFeedbackRequests')).toHaveLength(2);
    });

    it('returns parsed requests with endsAt in epoch ms', async () => {
        server.use(serverList(view(A, { question: 'How is it going?', endsAt: '2026-10-07T00:00:00.000Z' })));
        await expect(fetchActiveFeedbackRequests('en')).resolves.toEqual({
            ok: true,
            requests: [{ id: A, question: 'How is it going?', endsAt: Date.parse('2026-10-07T00:00:00.000Z'), answered: false }],
        });
    });

    it('drops rows with no id, a blank question or an unparseable endsAt, keeps answered ones', async () => {
        server.use(
            mockGql('ActiveFeedbackRequests', {
                activeFeedbackRequests: [
                    null,
                    view('', {}),
                    view(A, { question: '   ' }),
                    view(A, { endsAt: 'not a date' }),
                    view(A, { question: 'q', endsAt: '2026-10-07T00:00:00Z', answered: true }),
                ],
            }),
        );
        await expect(fetchActiveFeedbackRequests('en')).resolves.toEqual({
            ok: true,
            requests: [{ id: A, question: 'q', endsAt: Date.parse('2026-10-07T00:00:00Z'), answered: true }],
        });
    });

    it('treats a null list as empty', async () => {
        server.use(mockGql('ActiveFeedbackRequests', { activeFeedbackRequests: null }));
        await expect(fetchActiveFeedbackRequests('en')).resolves.toEqual({ ok: true, requests: [] });
    });

    // The error link owns the Sentry capture (once); this file only breadcrumbs.
    it('on a GraphQL failure: ok false, breadcrumb with the codes, one capture from the link, no banner', async () => {
        const logs = spyLogger();
        server.use(mockGqlError('ActiveFeedbackRequests', 'INTERNAL_SERVER_ERROR'));
        await expect(fetchActiveFeedbackRequests('en')).resolves.toEqual({ ok: false, offline: false });
        expect(logs.capture).toHaveBeenCalledTimes(1);
        expect(logs.crumb).toHaveBeenCalledWith(
            '[feedback-request] fetchActiveFeedbackRequests failed',
            'feedback-request',
            { method: 'fetchActiveFeedbackRequests', codes: ['INTERNAL_SERVER_ERROR'] },
            'warning',
        );
        expect(banner()).toBeNull();
    });

    it('a failure never paints the feed sync-failed banner, whatever the code', async () => {
        spyLogger();
        server.use(mockGqlError('ActiveFeedbackRequests', 'BAD_USER_INPUT'));
        await fetchActiveFeedbackRequests('en');
        expect(banner()).toBeNull();
    });

    it('reports offline when the device link is known down', async () => {
        spyLogger();
        setDeviceLink(false);
        server.use(failOp('ActiveFeedbackRequests'));
        await expect(fetchActiveFeedbackRequests('en')).resolves.toEqual({ ok: false, offline: true });
    });

    it('does not report offline for a transport failure while the link is believed up', async () => {
        spyLogger();
        server.use(failOp('ActiveFeedbackRequests'));
        await expect(fetchActiveFeedbackRequests('en')).resolves.toEqual({ ok: false, offline: false });
    }, 15_000);
});

describe('submitFeedbackResponse', () => {
    it('sends the trimmed text and the request id only', async () => {
        const sent = recordOps();
        await expect(submitFeedbackResponse(A, '  great  ')).resolves.toEqual({ status: 'ok', alreadyAnswered: false });
        await settleRecorder();
        expect(opsNamed(sent, 'SubmitFeedbackResponse').map((s) => s.variables)).toEqual([
            { input: { feedbackRequestId: A, text: 'great' } },
        ]);
    });

    it('trims first, then caps the text at FEEDBACK_RESPONSE_MAX_CHARS', async () => {
        const sent = recordOps();
        await submitFeedbackResponse(A, `   ${'a'.repeat(FEEDBACK_RESPONSE_MAX_CHARS + 500)}`);
        await settleRecorder();
        const text = opsNamed(sent, 'SubmitFeedbackResponse')[0].variables.input.text as string;
        expect(FEEDBACK_RESPONSE_MAX_CHARS).toBe(2000);
        expect(text).toBe('a'.repeat(FEEDBACK_RESPONSE_MAX_CHARS));
    });

    it('never sends an empty answer', async () => {
        const sent = recordOps();
        await expect(submitFeedbackResponse(A, '   ')).resolves.toEqual({ status: 'error', offline: false });
        await settleRecorder();
        expect(opsNamed(sent, 'SubmitFeedbackResponse')).toHaveLength(0);
    });

    it('alreadyAnswered is a success', async () => {
        server.use(submitted({ ok: false, alreadyAnswered: true }));
        await expect(submitFeedbackResponse(A, 'x')).resolves.toEqual({ status: 'ok', alreadyAnswered: true });
    });

    it('ok false without alreadyAnswered is an error, with a breadcrumb', async () => {
        const logs = spyLogger();
        server.use(submitted({ ok: false }));
        await expect(submitFeedbackResponse(A, 'x')).resolves.toEqual({ status: 'error', offline: false });
        expect(crumbMessages(logs.crumb)).toContain('[feedback-request] submitFeedbackResponse failed');
    });

    it('an empty result is an error', async () => {
        spyLogger();
        server.use(mockGql('SubmitFeedbackResponse', { submitFeedbackResponse: null }));
        await expect(submitFeedbackResponse(A, 'x')).resolves.toEqual({ status: 'error', offline: false });
    });

    // expectedErrorCodes: a closed question is an outcome the screen shows, not a fault.
    it('FEEDBACK_REQUEST_CLOSED is closed: an info breadcrumb, no capture, no banner', async () => {
        const logs = spyLogger();
        server.use(mockGqlError('SubmitFeedbackResponse', FEEDBACK_REQUEST_CLOSED));
        await expect(submitFeedbackResponse(A, 'x')).resolves.toEqual({ status: 'closed' });
        expect(logs.capture).not.toHaveBeenCalled();
        expect(logs.crumb).toHaveBeenCalledWith(
            'GraphQL expected error',
            'apollo-error-link',
            { operationName: 'SubmitFeedbackResponse', errorCode: FEEDBACK_REQUEST_CLOSED },
            'info',
        );
        expect(banner()).toBeNull();
    });

    it('any other GraphQL error is an error, captured once by the link, with no banner', async () => {
        const logs = spyLogger();
        server.use(mockGqlError('SubmitFeedbackResponse', 'INTERNAL_SERVER_ERROR'));
        await expect(submitFeedbackResponse(A, 'x')).resolves.toEqual({ status: 'error', offline: false });
        expect(logs.capture).toHaveBeenCalledTimes(1);
        expect(banner()).toBeNull();
    });

    it('a transport failure is an error, offline when the device link is down', async () => {
        spyLogger();
        setDeviceLink(false);
        server.use(failOp('SubmitFeedbackResponse'));
        await expect(submitFeedbackResponse(A, 'x')).resolves.toEqual({ status: 'error', offline: true });
    });

    it('a transport failure while the link is believed up is an error, not offline', async () => {
        spyLogger();
        server.use(failOp('SubmitFeedbackResponse'));
        await expect(submitFeedbackResponse(A, 'x')).resolves.toEqual({ status: 'error', offline: false });
    }, 15_000);
});
