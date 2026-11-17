// Seam test for the two GraphQL calls behind feedback requests: the real Apollo client and error
// link against MSW. Outcomes are what the modal and the sync task can observe.
import { resetNetworkAndBanner, banner, spyLogger, A } from './support';
import {
    FEEDBACK_REQUEST_CLOSED,
    fetchActiveFeedbackRequests,
    submitFeedbackResponse,
} from '@/lib/feedback-requests/feedback-request-service';
import { mockGqlError, server } from '@/test/helpers';

beforeEach(resetNetworkAndBanner);

describe('fetchActiveFeedbackRequests', () => {

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
});

describe('submitFeedbackResponse', () => {

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
});
