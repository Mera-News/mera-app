import { changeSummary, type ChangeContext, type ChangeRow } from '../change-summary';

// The key plus its params, so a test reads which template a row picked.
const t = ((key: string, params?: Record<string, unknown>) => (params ? `${key} ${JSON.stringify(params)}` : key)) as never;

const row = (actionType: string, action: Record<string, unknown>, id = 'r1'): ChangeRow => ({
    id,
    actionType,
    actionJson: JSON.stringify(action),
});

const ctx = (over: Partial<ChangeContext> = {}): ChangeContext => ({
    targets: new Map(),
    publication: (name) => name,
    rowsById: new Map(),
    ...over,
});

describe('changeSummary', () => {
    it('names a topic it can look up, and falls back to the action label when it cannot', () => {
        const targets = new Map([['t1', { text: 'Formula 1' }]]);
        expect(changeSummary(t, row('retire_topic', { targetId: 't1' }), ctx({ targets }))).toBe(
            'personaAudit.summary.removed {"name":"Formula 1"}',
        );
        expect(changeSummary(t, row('retire_topic', { targetId: 'gone' }), ctx())).toBe('personaAudit.actionLabels.retireTopic');
    });

    it('reads a weight change as a direction, never as numbers', () => {
        const targets = new Map([['f1', { text: 'Likes chess' }]]);
        expect(changeSummary(t, row('set_fact_weight', { targetId: 'f1', before: null, after: 0.7 }), ctx({ targets }))).toBe(
            'personaAudit.summary.countsLess {"name":"Likes chess"}',
        );
        expect(changeSummary(t, row('set_topic_weight', { targetId: 'f1', before: 0.2, after: 0.5 }), ctx({ targets }))).toBe(
            'personaAudit.summary.countsMore {"name":"Likes chess"}',
        );
    });

    it('maps a publication preference to words, in the display name', () => {
        const c = ctx({ publication: (n) => `${n} (display)` });
        expect(changeSummary(t, row('set_publication_pref', { targetId: 'BBC', after: 'boost' }), c)).toBe(
            'personaAudit.summary.moreFrom {"name":"BBC (display)"}',
        );
        expect(changeSummary(t, row('set_publication_pref', { targetId: 'BBC', after: 'deprioritize' }), c)).toBe(
            'articleMenu.fewerFrom {"source":"BBC (display)"}',
        );
        expect(changeSummary(t, row('set_publication_pref', { targetId: 'BBC', after: 'none' }), c)).toBe(
            'personaAudit.summary.cleared {"name":"BBC (display)"}',
        );
    });

    it('names a country scope from its code when no label was logged', () => {
        expect(changeSummary(t, row('set_source_scope_pref', { targetId: 'country:IND', after: 'none' }), ctx())).toBe(
            'personaAudit.summary.clearedSourcesFrom {"name":"India"}',
        );
    });

    it('names a place from the row itself', () => {
        expect(changeSummary(t, row('add_location', { targetId: 'l1', city: null, countryCode: 'DE' }), ctx())).toBe(
            'personaAudit.summary.added {"name":"Germany"}',
        );
    });

    it('an undo names the change it undid', () => {
        const undone = row('add_topic', { targetId: 't9', text: 'Cricket' }, 'r0');
        const c = ctx({ rowsById: new Map([['r0', undone]]) });
        expect(changeSummary(t, row('revert_change', { targetId: 'r0', revertedActionType: 'add_topic' }), c)).toBe(
            'personaAudit.summary.undone {"change":"personaAudit.summary.added {\\"name\\":\\"Cricket\\"}"}',
        );
        expect(changeSummary(t, row('revert_change', { targetId: 'r-gone', revertedActionType: 'add_topic' }), ctx())).toBe(
            'personaAudit.summary.undone {"change":"personaAudit.actionLabels.addTopic"}',
        );
    });

    it('calibration and unreadable rows render their label', () => {
        expect(changeSummary(t, row('set_scoring_override', { before: {}, after: {} }), ctx())).toBe(
            'personaAudit.actionLabels.setScoringOverride',
        );
        expect(changeSummary(t, { id: 'x', actionType: 'mystery', actionJson: '{' }, ctx())).toBe('personaAudit.actionLabels.unknown');
    });
});
