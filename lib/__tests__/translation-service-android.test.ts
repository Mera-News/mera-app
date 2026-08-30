// The main translation-service suite pins Platform.OS to 'ios' at import time
// (the module evaluates its source-code set on load), so the Android call
// boundary needs its own file.
const mockOnTranslateTask = jest.fn();
jest.mock('expo-translate-text', () => ({
    onTranslateTask: (...a: any[]) => mockOnTranslateTask(...a),
}));

jest.mock('@/lib/logger', () => ({
    __esModule: true,
    default: {
        captureException: jest.fn(),
        captureMessage: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
        debug: jest.fn(),
        info: jest.fn(),
    },
}));

jest.mock('react-native', () => ({
    Platform: {
        OS: 'android',
        select: jest.fn((obj: Record<string, unknown>) => obj.android),
    },
}));

import { clearTranslationFailures, translateText } from '../translation-service';

// MERA-APP-6H: `TranslationError: Invalid target language: zh-Hans`.
//
// Android resolves the tag through ML Kit's TranslateLanguage.fromLanguageTag,
// which knows only bare ISO-639-1 tags and returns null for every
// script-suffixed code the app uses. The support check had already reduced to
// the primary subtag while the CALL still passed the full tag, so Android
// answered "yes, I can translate into zh-Hans" and then rejected it.
describe('Android native target language code', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        clearTranslationFailures();
        mockOnTranslateTask.mockResolvedValue({ results: ['translated'] });
    });

    it('sends bare zh to the native module for zh-Hans', async () => {
        await translateText('Hello', 'zh-Hans');

        expect(mockOnTranslateTask).toHaveBeenCalledWith(
            expect.objectContaining({ targetLangCode: 'zh' }),
        );
    });

    it('sends bare zh for zh-Hant too — ML Kit ships one Chinese model', async () => {
        await translateText('Hello', 'zh-Hant');

        expect(mockOnTranslateTask).toHaveBeenCalledWith(
            expect.objectContaining({ targetLangCode: 'zh' }),
        );
    });

    it('leaves an already-bare code untouched', async () => {
        await translateText('Hello', 'fr');

        expect(mockOnTranslateTask).toHaveBeenCalledWith(
            expect.objectContaining({ targetLangCode: 'fr' }),
        );
    });
});
