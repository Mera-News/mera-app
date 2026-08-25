const mockWarn = jest.fn();

jest.mock('@/lib/logger', () => ({
    __esModule: true,
    default: {
        warn: (...args: unknown[]) => mockWarn(...args),
        captureException: jest.fn(),
        error: jest.fn(),
        debug: jest.fn(),
        info: jest.fn(),
    },
}));

// `mock`-prefixed so jest's out-of-scope guard allows the factory to close
// over it (the module is required lazily).
const mockLanguage = { code: 'en' };
jest.mock('@/lib/stores/app-language-store', () => ({
    useAppLanguageStore: {
        getState: () => ({ appLanguage: mockLanguage.code }),
    },
}));

jest.mock('@/lib/translation-service', () => ({
    SUPPORTED_LANGUAGES: [
        { code: 'en', name: 'English' },
        { code: 'nl', name: 'Dutch' },
    ],
}));

const mockProtocol = { processingMode: 'CLOUD', webSearchInChat: true };
jest.mock('@/lib/stores/mera-protocol-store', () => ({
    useMeraProtocolStore: { getState: () => mockProtocol },
}));

jest.mock('@/lib/generated/graphql-types', () => ({
    ProcessingMode: { OnDevice: 'ON_DEVICE', Cloud: 'CLOUD' },
}));

const mockHandleWebSearch = jest.fn();
jest.mock('@/lib/chat-tools/web-search-handler', () => ({
    handleWebSearch: (...args: unknown[]) => mockHandleWebSearch(...args),
}));

import { TutorialHelpAgent } from '../TutorialHelpAgent';

describe('TutorialHelpAgent', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        mockLanguage.code = 'en';
    });

    it('scopes its conversation id to the user', () => {
        expect(new TutorialHelpAgent('u1', null).id).toBe('tutorial-help-u1');
    });

    // THE POINT OF THE CLASS: `webSearch` is read-only. Every tool that could
    // MUTATE the reader's profile or settings must stay absent, because routing
    // a tutorial question at an agent that had them is the bug this class exists
    // to prevent.
    it('offers webSearch and nothing that can change anything', () => {
        const agent = new TutorialHelpAgent('u1', 'tutorials/privacy/what-leaves');
        expect(agent.getToolDefinitions().map((t) => t.function.name)).toEqual(['webSearch']);
    });

    it('offers NO tools at all when the user has web search off', () => {
        mockProtocol.webSearchInChat = false;
        try {
            expect(new TutorialHelpAgent('u1', null).getToolDefinitions()).toEqual([]);
        } finally {
            mockProtocol.webSearchInChat = true;
        }
    });

    it('offers NO tools on the on-device path — that turn cannot read a result', () => {
        mockProtocol.processingMode = 'ON_DEVICE';
        try {
            expect(new TutorialHelpAgent('u1', null).getToolDefinitions()).toEqual([]);
        } finally {
            mockProtocol.processingMode = 'CLOUD';
        }
    });

    it('executes webSearch instead of refusing it', async () => {
        mockHandleWebSearch.mockResolvedValue({ searched: true, searches: [] });
        const agent = new TutorialHelpAgent('u1', null);

        await agent.executeTool('webSearch', { queries: ['who won'] });

        expect(mockHandleWebSearch).toHaveBeenCalledWith({ queries: ['who won'] });
    });

    it('offers no forced-extraction tools either, so that pass is skipped', () => {
        // A non-empty list here would be called with `tool_choice:'required'` on
        // a purely conversational turn — which every turn here is.
        expect(new TutorialHelpAgent('u1', null).getForcedExtractionTools()).toEqual([]);
    });

    it('refuses an invented tool call instead of throwing', async () => {
        const agent = new TutorialHelpAgent('u1', null);

        const result = await agent.executeTool('saveExtractedFacts', { facts: [] });

        expect(result.result).toMatchObject({ error: expect.any(String) });
        expect(mockWarn).toHaveBeenCalled();
        // Crucially: no side effects reported, so nothing downstream applies it.
        expect(result.sideEffects).toBeUndefined();
    });

    it('seeds its context from the slide the reader is on', async () => {
        const agent = new TutorialHelpAgent('u1', 'tutorials/sources/the-two-badges');
        const context = await agent.buildContext();

        expect(context).toContain('sources');
        expect(context).toContain('the-two-badges');
    });

    it('still produces a context with no route', async () => {
        const context = await new TutorialHelpAgent('u1', null).buildContext();
        expect(context).toContain('<context>');
    });

    it('builds a prompt in the app language', async () => {
        mockLanguage.code = 'nl';
        const prompt = await new TutorialHelpAgent('u1', null).buildSystemPrompt();
        expect(prompt).toContain('ALWAYS reply in **Dutch**');
    });

    it('falls back to English for an unmapped app language', async () => {
        mockLanguage.code = 'xx';
        const prompt = await new TutorialHelpAgent('u1', null).buildSystemPrompt();
        expect(prompt).toContain('ALWAYS reply in **English**');
    });

    it('caches the prompt, and rebuilds it when the language changes', async () => {
        const agent = new TutorialHelpAgent('u1', null);

        const first = await agent.buildSystemPrompt();
        const second = await agent.buildSystemPrompt();
        expect(second).toBe(first);

        mockLanguage.code = 'nl';
        const third = await agent.buildSystemPrompt();
        expect(third).not.toBe(first);
    });
});
