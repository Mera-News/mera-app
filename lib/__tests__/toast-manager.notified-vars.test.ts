// A notified toast ("Fact check ready", hygiene, calibration, the optimisation
// plan) must render its title and body WITH the context's values. The row it
// persists keeps the raw key plus `context` (the notification centre
// interpolates from it); the transient toast used to resolve the keys with no
// values at all, so the reader saw 'No published fact checks yet for
// "{{title}}".' (owner bug, ux1).
import i18next from 'i18next';

jest.mock('../logger', () => ({
    __esModule: true,
    default: { warn: jest.fn(), info: jest.fn(), error: jest.fn(), captureException: jest.fn() },
}));
jest.mock('../notifications/bell-anchor', () => ({ getBellAnchor: () => null }));
jest.mock('@/lib/database/services/notification-service', () => ({ notify: jest.fn(async () => {}) }));
const mockNotified = jest.fn((..._a: any[]) => null);
jest.mock('@/components/custom/notifications/NotifiedToast', () => ({
    __esModule: true,
    default: (p: any) => mockNotified(p),
    notifiedToastDurationMs: () => 4000,
}));
jest.mock('react', () => ({
    ...jest.requireActual('react'),
    createElement: (type: any, props: any) => (typeof type === 'function' ? type(props) : null),
}));

import { toastManager } from '../toast-manager';

const en = require('../locales/en.json');

beforeAll(async () => {
    await i18next.init({ lng: 'en', resources: { en: { translation: en } }, interpolation: { escapeValue: false } });
});

function render(opts: any) {
    const show = jest.fn((o: any) => o.render({ id: 't1' }));
    (toastManager as any).toastInstance = { show, close: jest.fn(), closeAll: jest.fn(), isActive: () => false };
    return toastManager.showNotifiedToast(opts);
}

beforeEach(() => mockNotified.mockClear());

it('renders the fact-check body with the article title, never a raw placeholder', async () => {
    await render({
        type: 'fact_check_done',
        source: 'fact-check',
        title: 'factCheck.notify.title',
        body: 'factCheck.notify.bodyNone',
        context: { title: 'Budget vote delayed' },
    });
    const p = mockNotified.mock.calls[0][0];
    expect(p.title).toBe('Fact check ready');
    expect(p.body).toBe('No published fact checks yet for "Budget vote delayed".');
    expect(p.body).not.toMatch(/\{\{/);
});

it('interpolates counts the same way (hygiene, calibration, the plan)', async () => {
    await render({
        type: 'hygiene',
        source: 'hygiene',
        title: 'hygiene.notificationTitle',
        body: 'hygiene.notificationBody',
        context: { count: 3 },
    });
    expect(mockNotified.mock.calls[0][0].body).not.toMatch(/\{\{/);
    expect(mockNotified.mock.calls[0][0].body).toMatch(/3/);
});
