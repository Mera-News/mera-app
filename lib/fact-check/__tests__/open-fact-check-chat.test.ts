// open-fact-check-chat unit tests. The assertion that matters is the SEAM:
// the tick opens Mera AI through the existing `openArticleFeedback(context,
// initialMessage)` store action — the SAME one `startFollowStoryChat` uses —
// on the `article-suggestion` context, NOT the retired standalone
// `kind: 'fact-check'` context or a new channel of its own.

const mockOpenArticleFeedback = jest.fn();
const mockExpand = jest.fn();
const mockHapticLight = jest.fn();

jest.mock('../../stores/floating-chat-store', () => ({
    useFloatingChatStore: {
        getState: () => ({
            openArticleFeedback: (...args: unknown[]) => mockOpenArticleFeedback(...args),
            expand: (...args: unknown[]) => mockExpand(...args),
        }),
    },
}));

jest.mock('../../haptics', () => ({
    hapticLight: (...args: unknown[]) => mockHapticLight(...args),
}));

// Defaults to Cloud — the vast majority of tests here exercise the seeding
// seam itself, not the gate, and Cloud is the store's own documented default
// processing mode.
let mockProcessingMode = 'CLOUD';
jest.mock('../../stores/mera-protocol-store', () => ({
    useMeraProtocolStore: {
        getState: () => ({ processingMode: mockProcessingMode }),
    },
}));

import { openFactCheckChat } from '../open-fact-check-chat';

beforeEach(() => {
    jest.clearAllMocks();
    mockProcessingMode = 'CLOUD';
});

describe('openFactCheckChat', () => {
    it('opens the chat on the article-suggestion context, seeded with the resolved message', () => {
        openFactCheckChat({ articleId: 'a1', title: 'A headline' }, 'What can be fact-checked in this story?');

        expect(mockOpenArticleFeedback).toHaveBeenCalledTimes(1);
        expect(mockOpenArticleFeedback).toHaveBeenCalledWith(
            { kind: 'article-suggestion', articleId: 'a1', articleTitle: 'A headline' },
            'What can be fact-checked in this story?',
        );
    });

    it('carries the suggestion id through when the caller has one', () => {
        openFactCheckChat({ articleId: 'a1', suggestionId: 's1', title: 'A headline' }, 'seed');

        expect(mockOpenArticleFeedback).toHaveBeenCalledWith(
            { kind: 'article-suggestion', articleId: 'a1', suggestionId: 's1', articleTitle: 'A headline' },
            'seed',
        );
    });

    it('omits suggestionId entirely rather than passing it as undefined', () => {
        openFactCheckChat({ articleId: 'a1', title: 'A headline' }, 'seed');

        const [context] = mockOpenArticleFeedback.mock.calls[0];
        expect('suggestionId' in context).toBe(false);
    });

    // The retired standalone kind must never come back through this seam —
    // that context and its ChatContext union member are gone this wave.
    it('never uses the retired "fact-check" context kind', () => {
        openFactCheckChat({ articleId: 'a1', title: 'A headline' }, 'seed');

        const [context] = mockOpenArticleFeedback.mock.calls[0];
        expect(context.kind).toBe('article-suggestion');
        expect(context.kind).not.toBe('fact-check');
    });

    it('does NOT use the plain expand() path (which seeds nothing)', () => {
        openFactCheckChat({ articleId: 'a1', title: 'A headline' }, 'seed');

        expect(mockExpand).not.toHaveBeenCalled();
    });

    it('fires the tap haptic', () => {
        openFactCheckChat({ articleId: 'a1', title: 'A headline' }, 'seed');

        expect(mockHapticLight).toHaveBeenCalledTimes(1);
    });

    it('passes the caller-resolved string through verbatim (no i18n in lib/)', () => {
        openFactCheckChat({ articleId: 'a1', title: 'A headline' }, 'Que peut-on vérifier dans cet article ?');

        expect(mockOpenArticleFeedback).toHaveBeenCalledWith(
            expect.objectContaining({ kind: 'article-suggestion' }),
            'Que peut-on vérifier dans cet article ?',
        );
    });

    // ── The on-device gate (flagged by Q1 — proposeFactCheck is CLOUD-only) ──
    // Without this, a tap on a device set to on-device processing seeds a turn
    // into an agent with no `proposeFactCheck` tool: not an error, a silent
    // mis-wire — the exact failure mode `ChatSessionView`'s own comments warn
    // about for the persona starter chips.
    describe('on-device processing gate', () => {
        it('no-ops when the device is set to on-device processing', () => {
            mockProcessingMode = 'ON_DEVICE';
            openFactCheckChat({ articleId: 'a1', title: 'A headline' }, 'seed');

            expect(mockOpenArticleFeedback).not.toHaveBeenCalled();
        });

        it('does not even fire the haptic on-device — no partial affordance', () => {
            mockProcessingMode = 'ON_DEVICE';
            openFactCheckChat({ articleId: 'a1', title: 'A headline' }, 'seed');

            expect(mockHapticLight).not.toHaveBeenCalled();
        });

        it('still opens normally in cloud mode', () => {
            mockProcessingMode = 'CLOUD';
            openFactCheckChat({ articleId: 'a1', title: 'A headline' }, 'seed');

            expect(mockOpenArticleFeedback).toHaveBeenCalledTimes(1);
        });
    });
});
