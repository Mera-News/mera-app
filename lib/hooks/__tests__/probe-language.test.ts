const mockResolvers: Array<(v: 'success' | 'failed') => void> = [];
const mockProbe = jest.fn(
    (..._args: unknown[]) => new Promise<'success' | 'failed'>((resolve) => mockResolvers.push(resolve)),
);

jest.mock('@/lib/translation-service', () => ({
    probeTranslationLanguage: (...args: unknown[]) => mockProbe(...args),
    resolveUiLocale: jest.fn(),
}));
jest.mock('@/lib/stores/app-language-store', () => ({ useAppLanguageStore: jest.fn() }));
jest.mock('@/lib/i18n', () => ({ previewLanguage: jest.fn() }));
jest.mock('@/lib/logger', () => ({ __esModule: true, default: { info: jest.fn(), warn: jest.fn() } }));
let mockAppStateHandlers: Array<(state: string) => void> = [];
jest.mock('react-native', () => ({
    BackHandler: {},
    Platform: { OS: 'ios' },
    AppState: {
        currentState: 'active',
        addEventListener: (_: string, h: (state: string) => void) => {
            mockAppStateHandlers.push(h);
            return { remove: () => (mockAppStateHandlers = mockAppStateHandlers.filter((x) => x !== h)) };
        },
    },
}));

import { currentProbe, probeLanguage, probeSawSheet } from '@/lib/hooks/use-language-switch';

// The download notice shows exactly while a probe call is open, so this is the
// whole contract: in while the call runs, out when it settles, either way.
test('tracks each probe from the call until it settles, newest first', async () => {
    expect(currentProbe()).toBeNull();

    const de = probeLanguage('de', 20_000);
    const fr = probeLanguage('fr');
    expect(mockProbe).toHaveBeenCalledWith('de', 20_000);
    expect(currentProbe()?.code).toBe('fr');

    mockResolvers[1]('success');
    await fr;
    expect(currentProbe()?.code).toBe('de');

    mockResolvers[0]('failed');
    await expect(de).resolves.toBe('failed');
    expect(currentProbe()).toBeNull();
});

test('a retry of the same language is a new probe', async () => {
    const first = probeLanguage('pl');
    const stuck = currentProbe();
    const retry = probeLanguage('pl');
    expect(currentProbe()).not.toBe(stuck);
    expect(currentProbe()?.code).toBe('pl');
    mockResolvers[mockResolvers.length - 1]('success');
    await retry;
    expect(currentProbe()).toBe(stuck);
    mockResolvers[mockResolvers.length - 2]('failed');
    await first;
    expect(currentProbe()).toBeNull();
});

test('a probe that throws still leaves the list', async () => {
    mockProbe.mockImplementationOnce(() => Promise.reject(new Error('cancelled')));
    await expect(probeLanguage('ja')).rejects.toThrow('cancelled');
    expect(currentProbe()).toBeNull();
});

// The one outside sign of Apple's sheet is iOS reporting the app not active.
// The probe watches for it from the moment its call starts, so a short blip
// is kept even if the page's own effects run late.
test('a probe remembers an inactive blip during its call, and stops watching when it settles', async () => {
    const quiet = probeLanguage('it');
    const quietProbe = currentProbe()!;
    const sheet = probeLanguage('ar');
    const sheetProbe = currentProbe()!;
    mockAppStateHandlers.forEach((h) => h('inactive'));
    mockAppStateHandlers.forEach((h) => h('active'));
    expect(probeSawSheet(sheetProbe)).toBe(true);
    // Both calls were open, so both saw it; a probe started after it did not.
    const later = probeLanguage('ko');
    expect(probeSawSheet(currentProbe()!)).toBe(false);
    expect(probeSawSheet(quietProbe)).toBe(true);
    mockResolvers.slice(-3).forEach((r) => r('success'));
    await Promise.all([quiet, sheet, later]);
    expect(mockAppStateHandlers).toHaveLength(0);
});
