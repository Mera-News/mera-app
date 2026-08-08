import {
    buildTutorialHelpContext,
    buildTutorialHelpPrompt,
    parseTutorialRoute,
} from '../index';

describe('parseTutorialRoute', () => {
    it('splits a tutorial route into chapter and slide', () => {
        expect(parseTutorialRoute('tutorials/privacy/what-leaves')).toEqual({
            chapterId: 'privacy',
            slideId: 'what-leaves',
        });
    });

    it('tolerates surrounding slashes', () => {
        expect(parseTutorialRoute('/tutorials/feed/two-lists/')).toEqual({
            chapterId: 'feed',
            slideId: 'two-lists',
        });
    });

    it('returns null for anything that is not a tutorial route', () => {
        // `{ kind: 'generic' }` is a shared seam other surfaces will use, so an
        // unrecognised route must degrade rather than throw inside a prompt.
        expect(parseTutorialRoute(null)).toBeNull();
        expect(parseTutorialRoute(undefined)).toBeNull();
        expect(parseTutorialRoute('')).toBeNull();
        expect(parseTutorialRoute('settings/language')).toBeNull();
        expect(parseTutorialRoute('tutorials/privacy')).toBeNull();
        expect(parseTutorialRoute('tutorials/a/b/c')).toBeNull();
    });
});

describe('buildTutorialHelpContext', () => {
    it('names the chapter and slide the reader is on', () => {
        const context = buildTutorialHelpContext('tutorials/sources/the-two-badges');
        expect(context).toContain('sources');
        expect(context).toContain('the-two-badges');
        expect(context.startsWith('<context>')).toBe(true);
        expect(context.trim().endsWith('</context>')).toBe(true);
    });

    it('degrades to a generic line when the route is unusable', () => {
        const context = buildTutorialHelpContext('somewhere/else');
        expect(context).toContain('in-app guide');
        expect(context.startsWith('<context>')).toBe(true);
    });

    it('carries nothing about the user', () => {
        // The whole reason this agent exists is that the persona agent pulled a
        // profile into a product question. Its context must stay empty of one.
        const context = buildTutorialHelpContext('tutorials/facts/a-fact-is');
        expect(context).not.toMatch(/fact:|interest|topic weight|email/i);
    });
});

describe('buildTutorialHelpPrompt', () => {
    it('states plainly that it has no tools and changes nothing', () => {
        const prompt = buildTutorialHelpPrompt();
        expect(prompt).toContain('NO tools');
        expect(prompt).toMatch(/never say or imply that you have changed anything/i);
    });

    it('pins the privacy facts the chapters correct', () => {
        const prompt = buildTutorialHelpPrompt();
        // Cloud is the default (mera-protocol-store DEFAULT_PROCESSING_MODE)…
        expect(prompt).toMatch(/default processing mode is CLOUD/i);
        // …and there is no decoy/noise feature at all. Pinned as a DENIAL, not
        // as an absence: the app shipped this claim for months, so a prompt that
        // merely stops mentioning it leaves the model free to invent it back.
        expect(prompt).toMatch(/NO decoy or noise-injection feature/i);
        expect(prompt).toMatch(/there is no "Inject noise" setting/i);
        // A bare thumb is discarded.
        expect(prompt).toMatch(/thumbs up or down with no reason.*discarded/i);
        // Mute is a hard exclusion, the down arrow is not.
        expect(prompt).toMatch(/Muting a source keeps it out entirely/i);
    });

    it('tells it to admit ignorance rather than invent a screen', () => {
        const prompt = buildTutorialHelpPrompt();
        expect(prompt).toMatch(/Settings → FAQ/);
        expect(prompt).toMatch(/Do not guess/i);
    });

    it('bans the jargon the app is trying to stop leaking', () => {
        const prompt = buildTutorialHelpPrompt();
        for (const word of ['persona', 'embedding', 'vector', 'cluster']) {
            expect(prompt).toContain(`"${word}"`);
        }
    });

    it('pins the reply language when one is given, and matches otherwise', () => {
        expect(buildTutorialHelpPrompt({ languageName: 'Dutch' })).toContain(
            'ALWAYS reply in **Dutch**',
        );
        expect(buildTutorialHelpPrompt()).toMatch(/Match the user's language/);
    });

    it('is stable for the same input — it is cached by the adapter', () => {
        expect(buildTutorialHelpPrompt({ languageName: 'French' })).toBe(
            buildTutorialHelpPrompt({ languageName: 'French' }),
        );
    });
});
