// request-article-fact-check unit tests.
//
// The assertion that matters is the SEAM, and the seam MOVED this wave: the
// tick used to hand Mera AI an opening user turn and let the chat's claim
// picker take over, which on a real device answered "the article metadata
// gives me only a headline… there's nothing specific to fact-check from this
// alone". It now calls the SERVER fact check for the article directly, and no
// chat opens at all. These tests pin both halves of that: the server IS called,
// and the floating chat is NOT opened.

const mockRequestFactCheck = jest.fn();
const mockHapticLight = jest.fn();
const mockOpenArticleFeedback = jest.fn();
const mockExpand = jest.fn();

jest.mock('../fact-check-graphql-client', () => ({
    requestFactCheck: (...args: unknown[]) => mockRequestFactCheck(...args),
}));

jest.mock('../../haptics', () => ({
    hapticLight: (...args: unknown[]) => mockHapticLight(...args),
}));

// Mocked so a regression that reopens the chat is a failed assertion here,
// not something only a device would notice.
jest.mock('../../stores/floating-chat-store', () => ({
    useFloatingChatStore: {
        getState: () => ({
            openArticleFeedback: (...args: unknown[]) => mockOpenArticleFeedback(...args),
            expand: (...args: unknown[]) => mockExpand(...args),
        }),
    },
}));

let mockFactCheckEnabled = true;
// Kept in the mock even though nothing reads it any more: the on-device gate
// was REMOVED this wave (a server check needs no cloud chat), and a test that
// still supplies the signal is what proves its removal is deliberate rather
// than an oversight — see the "on-device processing" case below.
let mockProcessingMode = 'CLOUD';
jest.mock('../../stores/mera-protocol-store', () => ({
    useMeraProtocolStore: {
        getState: () => ({
            factCheckEnabled: mockFactCheckEnabled,
            processingMode: mockProcessingMode,
        }),
    },
}));

let mockAiAccess = 'entitled';
// `serverTier` matters as much as the verdict: `isChatLocked()` refuses to act
// on a 'locked' reading the SERVER has not confirmed, so a test that sets only
// the verdict is describing a cold start, not a free-tier user.
let mockServerTier: string | null = 'starter';
jest.mock('../../stores/subscription-store', () => ({
    getAiAccess: () => mockAiAccess,
    useSubscriptionStore: { getState: () => ({ serverTier: mockServerTier }) },
}));

import { requestArticleFactCheck } from '../request-article-fact-check';

const article = { articleId: 'a1', title: 'A headline' };

beforeEach(() => {
    jest.clearAllMocks();
    mockFactCheckEnabled = true;
    mockProcessingMode = 'CLOUD';
    mockAiAccess = 'entitled';
});

describe('requestArticleFactCheck', () => {
    it('asks the SERVER for a check on this article', () => {
        expect(requestArticleFactCheck(article)).toBe(true);

        expect(mockRequestFactCheck).toHaveBeenCalledTimes(1);
        // No full shape supplied ⇒ no keep input; the client degrades to the
        // server row's own fields for the retention snapshot.
        expect(mockRequestFactCheck).toHaveBeenCalledWith('a1', 'A headline', undefined);
    });

    // ── Retention pass-through ─────────────────────────────────────────────
    // A fact-checked article is kept openable like a saved one; the tick is
    // where the screens hand over the full shape they already have.
    it('passes the full article through as the retention keep input', () => {
        const fullArticle = { _id: 'a1', title: 'A headline' } as never;
        requestArticleFactCheck({ ...article, article: fullArticle });

        expect(mockRequestFactCheck).toHaveBeenCalledWith('a1', 'A headline', {
            articleId: 'a1',
            article: fullArticle,
        });
    });

    it('passes the full suggestion through as the retention keep input', () => {
        const suggestion = { _id: 's1', articleId: 'a1' } as never;
        requestArticleFactCheck({ ...article, suggestion });

        expect(mockRequestFactCheck).toHaveBeenCalledWith('a1', 'A headline', {
            articleId: 'a1',
            suggestion,
        });
    });

    // The whole point of the rewire.
    it('does NOT open the chat', () => {
        requestArticleFactCheck(article);

        expect(mockOpenArticleFeedback).not.toHaveBeenCalled();
    });

    it('fires the tap haptic', () => {
        requestArticleFactCheck(article);

        expect(mockHapticLight).toHaveBeenCalledTimes(1);
    });

    it('no-ops on a missing article id', () => {
        expect(requestArticleFactCheck({ articleId: '', title: 'x' })).toBe(false);

        expect(mockRequestFactCheck).not.toHaveBeenCalled();
        expect(mockHapticLight).not.toHaveBeenCalled();
    });

    // ── The entitlement gate ──────────────────────────────────────────────
    // A locked tap must never reach the server: the ask is billable and starts
    // a job. What CHANGED this wave is what the user gets instead. It used to
    // be nothing at all, which read as a broken button; it is now the chat
    // popup, where Mera explains that fact checks need a plan.
    describe('free-tier gate', () => {
        beforeEach(() => {
            mockAiAccess = 'locked';
            mockServerTier = 'none';
        });

        it('issues no server ask when locked', () => {
            // `false` means "no billable ask was issued", NOT "nothing
            // happened" — the popup below opens on this same path.
            expect(requestArticleFactCheck(article)).toBe(false);
            expect(mockRequestFactCheck).not.toHaveBeenCalled();
        });

        it('opens the chat on the fact-check context instead of dead-ending', () => {
            requestArticleFactCheck(article);

            expect(mockExpand).toHaveBeenCalledWith({
                kind: 'fact-check',
                articleId: 'a1',
                articleTitle: 'A headline',
            });
            // The tap is answered, so it gets its haptic. The old assertion
            // here was the opposite, and was correct while the tap led
            // nowhere.
            expect(mockHapticLight).toHaveBeenCalled();
        });

        it('does NOT gate on an unconfirmed locked reading', () => {
            // Cold start: RevenueCat has answered 'locked' from an empty cache
            // but our server has not spoken. Refusing here would tell a paying
            // subscriber their fact check needs a plan, on every launch.
            mockServerTier = null;

            expect(requestArticleFactCheck(article)).toBe(true);
            expect(mockRequestFactCheck).toHaveBeenCalled();
            expect(mockExpand).not.toHaveBeenCalled();
        });
    });

    // ── NO FEATURE SWITCH ──────────────────────────────────────────────────
    // There was a `factCheckEnabled` toggle in Mera Protocol settings and it is
    // gone: fact checking is part of the product. The only remaining switch,
    // `autoCommunityFactCheck`, governs whether Mera LOOKS UP an existing check
    // on every article open — it has no say over a deliberate tap, which is
    // what this function is.
    it('asks regardless of any Mera Protocol setting', () => {
        expect(requestArticleFactCheck(article)).toBe(true);
        expect(mockRequestFactCheck).toHaveBeenCalledTimes(1);
        expect(mockHapticLight).toHaveBeenCalledTimes(1);
    });

    // ── The on-device gate — REMOVED, deliberately ─────────────────────────
    // It existed only because the CHAT's claim picker (`proposeFactCheck`) is
    // cloud-only, so seeding a turn into a local agent with no such tool was a
    // silent mis-wire. A server fact check needs no cloud chat, so a reader on
    // on-device processing may now ask for one — and the callers no longer hide
    // the tick for them.
    it('still asks the server when the device is set to on-device processing', () => {
        mockProcessingMode = 'ON_DEVICE';

        expect(requestArticleFactCheck(article)).toBe(true);
        expect(mockRequestFactCheck).toHaveBeenCalledWith('a1', 'A headline', undefined);
    });
});
