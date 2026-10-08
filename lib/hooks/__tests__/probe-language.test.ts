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
jest.mock('react-native', () => ({ BackHandler: {}, Platform: { OS: 'ios' } }));

import { probeLanguage, probingLanguage } from '@/lib/hooks/use-language-switch';

// The download notice shows exactly while a probe call is open, so this is the
// whole contract: in while the call runs, out when it settles, either way.
test('tracks each probe from the call until it settles, oldest first', async () => {
    expect(probingLanguage()).toBeNull();

    const de = probeLanguage('de', 20_000);
    const fr = probeLanguage('fr');
    expect(mockProbe).toHaveBeenCalledWith('de', 20_000);
    expect(probingLanguage()).toBe('de');

    mockResolvers[0]('failed');
    await expect(de).resolves.toBe('failed');
    expect(probingLanguage()).toBe('fr');

    mockResolvers[1]('success');
    await fr;
    expect(probingLanguage()).toBeNull();
});

test('a probe that throws still leaves the list', async () => {
    mockProbe.mockImplementationOnce(() => Promise.reject(new Error('cancelled')));
    await expect(probeLanguage('ja')).rejects.toThrow('cancelled');
    expect(probingLanguage()).toBeNull();
});
