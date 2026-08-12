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
jest.mock('../../stores/subscription-store', () => ({
    getAiAccess: () => mockAiAccess,
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
        expect(mockRequestFactCheck).toHaveBeenCalledWith('a1', 'A headline');
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

    // ── The entitlement gate — KEPT ────────────────────────────────────────
    // Both server resolvers sit behind SubscriptionGuard, so a locked tap could
    // only ever produce an error. It used to be enforced for free by routing
    // through the chat store; with the chat gone it has to be explicit.
    describe('free-tier gate', () => {
        it('no-ops when AI access is locked', () => {
            mockAiAccess = 'locked';

            expect(requestArticleFactCheck(article)).toBe(false);
            expect(mockRequestFactCheck).not.toHaveBeenCalled();
        });

        it('does not even fire the haptic when locked — no partial affordance', () => {
            mockAiAccess = 'locked';
            requestArticleFactCheck(article);

            expect(mockHapticLight).not.toHaveBeenCalled();
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
        expect(mockRequestFactCheck).toHaveBeenCalledWith('a1', 'A headline');
    });
});
