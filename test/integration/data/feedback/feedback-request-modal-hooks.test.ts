// Seam test for the two hooks behind FeedbackRequestModal: the consent guard and the card's
// load/submit/dismiss lifecycle. Real stores, in-memory DB, real Apollo client and MSW.
import { act, renderHook, waitFor } from '@testing-library/react-native';
import { __resetFeedbackRequestConsentForTests } from '@/components/custom/feedback-request/feedback-request-consent';
import {
    useFeedbackRequestCard,
    useFeedbackRequestConsent,
} from '@/components/custom/feedback-request/useFeedbackRequestModal';
import { getAll } from '@/lib/database/services/notification-service';
import {
    readFeedbackRequestsState,
    updateFeedbackRequestsState,
} from '@/lib/feedback-requests/feedback-request-state';
import {
    graphql,
    HttpResponse,
    mockGql,
    mockGqlError,
    server,
    signInFixtureAccount,
    useFakeClock,
} from '@/test/helpers';

const ID = 'aaaaaaaaaaaaaaaaaaaaaaaa';
// Real clock by default: waitFor under fake timers burns its fake timeout while MSW answers in real time.
const NOW = Date.now();
const HOUR = 3_600_000;

interface Sent {
    op: string;
    variables: Record<string, any>;
}

/** Every GraphQL operation the app sends from now on, with its variables. */
const stopRecording: (() => void)[] = [];
function recordOps(): Sent[] {
    const sent: Sent[] = [];
    const listener = ({ request }: { request: Request }) => {
        if (!request.url.endsWith('/graphql')) return;
        void request
            .clone()
            .json()
            .then((b: { operationName?: string; variables?: Record<string, any> }) => {
                if (b.operationName) sent.push({ op: b.operationName, variables: b.variables ?? {} });
            });
    };
    server.events.on('request:start', listener);
    stopRecording.push(() => server.events.removeListener('request:start', listener));
    return sent;
}
const opsNamed = (sent: Sent[], op: string) => sent.filter((s) => s.op === op);

const view = (id: string, over: Record<string, unknown> = {}) => ({
    __typename: 'FeedbackRequestView',
    id,
    question: 'What should we build next?',
    endsAt: new Date(NOW + HOUR).toISOString(),
    createdAt: new Date(NOW - HOUR).toISOString(),
    answered: false,
    ...over,
});
const serverList = (...views: ReturnType<typeof view>[]) =>
    mockGql('ActiveFeedbackRequests', { activeFeedbackRequests: views });
const failOp = (operationName: string) =>
    graphql.operation(({ operationName: name }) => (name === operationName ? HttpResponse.error() : undefined));

const rows = async () => (await getAll()).filter((n) => (n as any).source === `feedback_request:${ID}`);

/** Mounts the card hook and waits for the phase to leave `loading`. */
async function mountCard(...args: [id?: string]) {
    const id = args.length ? args[0] : ID;
    const hook = renderHook(() => useFeedbackRequestCard(id));
    // Generous: the real retry link re-sends a failed transport call after a delay.
    await waitFor(() => expect(hook.result.current.phase.kind).not.toBe('loading'), { timeout: 15_000 });
    return hook;
}

beforeEach(() => {
    __resetFeedbackRequestConsentForTests();
});
afterEach(() => {
    stopRecording.splice(0).forEach((stop) => stop());
});

describe('useFeedbackRequestConsent', () => {
    // First in the file: the auth client keeps its session atom for the whole file, so the
    // signed-out case must run before any test signs in.
    it('blocks and closes once when there is no session and no local user id', async () => {
        const onClose = jest.fn();
        // A fresh callback per render re-runs the effect, so only the once-guard keeps onClose to one call.
        const { result, rerender } = renderHook(() => useFeedbackRequestConsent(() => onClose()));
        await waitFor(() => expect(result.current.consent).toBe('blocked'));
        expect(onClose).toHaveBeenCalledTimes(1);
        rerender({});
        expect(onClose).toHaveBeenCalledTimes(1);
    });

    it('is clear for a fixture account on the current legal versions', async () => {
        await signInFixtureAccount();
        const onClose = jest.fn();
        const { result } = renderHook(() => useFeedbackRequestConsent(onClose));
        await waitFor(() => expect(result.current.consent).toBe('clear'));
        expect(onClose).not.toHaveBeenCalled();
    });

    it('blocks and closes once when the server publishes newer legal versions', async () => {
        await signInFixtureAccount();
        server.use(
            mockGql('LegalConsentAppConfig', {
                appConfig: { __typename: 'AppConfig', termsVersion: '2027-01-01', privacyVersion: '2027-01-01' },
            }),
        );
        const onClose = jest.fn();
        // A fresh callback per render re-runs the effect, so only the once-guard keeps onClose to one call.
        const { result, rerender } = renderHook(() => useFeedbackRequestConsent(() => onClose()));
        await waitFor(() => expect(result.current.consent).toBe('blocked'));
        expect(onClose).toHaveBeenCalledTimes(1);
        rerender({});
        expect(onClose).toHaveBeenCalledTimes(1);
    });

    it('fails open when the legal versions cannot be fetched', async () => {
        await signInFixtureAccount();
        server.use(failOp('LegalConsentAppConfig'));
        const onClose = jest.fn();
        const { result } = renderHook(() => useFeedbackRequestConsent(onClose));
        await waitFor(() => expect(result.current.consent).toBe('clear'), { timeout: 10_000 });
        expect(onClose).not.toHaveBeenCalled();
    });
});

describe('useFeedbackRequestCard load', () => {
    it.each([undefined, 'not-an-id', 'AAAAAAAAAAAAAAAAAAAAAAAA'.slice(1)])(
        'closes an invalid id (%s) without sending a request',
        async (bad) => {
            const sent = recordOps();
            const { result } = await mountCard(bad);
            expect(result.current.phase.kind).toBe('closed');
            expect(opsNamed(sent, 'ActiveFeedbackRequests')).toHaveLength(0);
        },
    );

    it('fetches an id unknown on the device once, records it and opens', async () => {
        server.use(serverList(view(ID)));
        const sent = recordOps();
        const { result } = await mountCard();
        expect(result.current.phase.kind).toBe('open');
        expect(result.current.question).toBe('What should we build next?');
        expect(opsNamed(sent, 'ActiveFeedbackRequests')).toHaveLength(1);

        const entry = (await readFeedbackRequestsState())[ID];
        expect(entry).toMatchObject({ question: 'What should we build next?', endsAt: NOW + HOUR });
        expect(entry.shownAt).toBeGreaterThanOrEqual(NOW);
        expect(entry.answeredAt).toBeUndefined();
        expect(await rows()).toHaveLength(1);
    });

    it('closes an id absent from the server list', async () => {
        server.use(serverList(view('bbbbbbbbbbbbbbbbbbbbbbbb')));
        const { result } = await mountCard();
        expect(result.current.phase.kind).toBe('closed');
    });

    it('shows already for an entry answered on the device, without fetching', async () => {
        await updateFeedbackRequestsState((s) => {
            s[ID] = { question: 'Q?', endsAt: Date.now() + HOUR, answeredAt: Date.now() - 1000 };
        });
        const sent = recordOps();
        const { result } = await mountCard();
        expect(result.current.phase.kind).toBe('already');
        expect(result.current.question).toBe('Q?');
        expect(opsNamed(sent, 'ActiveFeedbackRequests')).toHaveLength(0);
    });

    it('closes an entry past endsAt, without fetching', async () => {
        await updateFeedbackRequestsState((s) => {
            s[ID] = { question: 'Q?', endsAt: Date.now() - 1000 };
        });
        const sent = recordOps();
        const { result } = await mountCard();
        expect(result.current.phase.kind).toBe('closed');
        expect(opsNamed(sent, 'ActiveFeedbackRequests')).toHaveLength(0);
    });

    it('reports load-error when the list request fails, and retries through load', async () => {
        server.use(failOp('ActiveFeedbackRequests'));
        const { result } = await mountCard();
        expect(result.current.phase).toEqual({ kind: 'load-error', offline: false });

        server.use(serverList(view(ID)));
        await act(async () => {
            await result.current.load();
        });
        expect(result.current.phase.kind).toBe('open');
    });
});

describe('useFeedbackRequestCard submit', () => {
    async function openCard() {
        server.use(serverList(view(ID)));
        return mountCard();
    }

    it('submits the trimmed text, then shows thanks, stamps answeredAt and actions the row', async () => {
        const { result } = await openCard();
        const sent = recordOps();
        act(() => result.current.setAnswer('  x  '));
        expect(result.current.canSubmit).toBe(true);
        await act(async () => {
            await result.current.handleSubmit();
        });
        expect(result.current.phase.kind).toBe('thanks');
        expect(opsNamed(sent, 'SubmitFeedbackResponse').map((s) => s.variables.input)).toEqual([
            { feedbackRequestId: ID, text: 'x' },
        ]);
        expect((await readFeedbackRequestsState())[ID].answeredAt).toEqual(expect.any(Number));
        expect((await rows()).map((n) => (n as any).status)).toEqual(['actioned']);
    });

    it('shows closed when the server reports FEEDBACK_REQUEST_CLOSED', async () => {
        const { result } = await openCard();
        server.use(mockGqlError('SubmitFeedbackResponse', 'FEEDBACK_REQUEST_CLOSED'));
        act(() => result.current.setAnswer('x'));
        await act(async () => {
            await result.current.handleSubmit();
        });
        expect(result.current.phase.kind).toBe('closed');
    });

    it('shows already when the server says it was already answered', async () => {
        const { result } = await openCard();
        server.use(
            mockGql('SubmitFeedbackResponse', {
                submitFeedbackResponse: { __typename: 'SubmitFeedbackResponseResult', ok: true, alreadyAnswered: true },
            }),
        );
        act(() => result.current.setAnswer('x'));
        await act(async () => {
            await result.current.handleSubmit();
        });
        expect(result.current.phase.kind).toBe('already');
    });

    it('shows the error phase on a transport failure and keeps the answer', async () => {
        const { result } = await openCard();
        server.use(failOp('SubmitFeedbackResponse'));
        act(() => result.current.setAnswer('x'));
        await act(async () => {
            await result.current.handleSubmit();
        });
        expect(result.current.phase).toEqual({ kind: 'error', offline: false });
        expect(result.current.answer).toBe('x');
        expect(result.current.showsTextArea).toBe(true);
    });

    it('closes without sending once endsAt has passed', async () => {
        const { result } = await openCard();
        const sent = recordOps();
        act(() => result.current.setAnswer('x'));
        useFakeClock(NOW);
        jest.setSystemTime(NOW + HOUR + 1);
        await act(async () => {
            await result.current.handleSubmit();
        });
        expect(result.current.phase.kind).toBe('closed');
        expect(opsNamed(sent, 'SubmitFeedbackResponse')).toHaveLength(0);
    });

    it('does nothing for a blank answer', async () => {
        const { result } = await openCard();
        const sent = recordOps();
        act(() => result.current.setAnswer('   '));
        expect(result.current.canSubmit).toBe(false);
        await act(async () => {
            await result.current.handleSubmit();
        });
        expect(result.current.phase.kind).toBe('open');
        expect(opsNamed(sent, 'SubmitFeedbackResponse')).toHaveLength(0);
    });
});

describe('useFeedbackRequestCard dismissal', () => {
    it('stamps dismissedAt when unmounted while open', async () => {
        server.use(serverList(view(ID)));
        const { unmount } = await mountCard();
        unmount();
        expect((await readFeedbackRequestsState())[ID].dismissedAt).toEqual(expect.any(Number));
    });

    it('does not stamp dismissedAt after thanks', async () => {
        server.use(serverList(view(ID)));
        const { result, unmount } = await mountCard();
        act(() => result.current.setAnswer('x'));
        await act(async () => {
            await result.current.handleSubmit();
        });
        expect(result.current.phase.kind).toBe('thanks');
        unmount();
        expect((await readFeedbackRequestsState())[ID].dismissedAt).toBeUndefined();
    });

    it('does not stamp dismissedAt after closed', async () => {
        await updateFeedbackRequestsState((s) => {
            s[ID] = { question: 'Q?', endsAt: Date.now() - 1000 };
        });
        const { result, unmount } = await mountCard();
        expect(result.current.phase.kind).toBe('closed');
        unmount();
        expect((await readFeedbackRequestsState())[ID].dismissedAt).toBeUndefined();
    });
});
