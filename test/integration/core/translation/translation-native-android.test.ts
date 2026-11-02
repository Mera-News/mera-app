// expo-translate-text's wrapper forwards preferredStrategy even when unset, and its Kotlin bridge
// rejects any undefined value, so every Android translation failed at once (0.3.0). The native
// module is the only fake.
import { Platform } from 'react-native';

import { __resetTranslationStateForTests, probeTranslationLanguage } from '@/lib/translation-service';

const mockOnTranslateTask: jest.Mock = jest.requireMock('expo-translate-text').onTranslateTask;

let os: typeof Platform.OS;
beforeEach(() => {
    __resetTranslationStateForTests();
    mockOnTranslateTask.mockReset();
    os = Platform.OS;
    Platform.OS = 'android';
});
afterEach(() => {
    Platform.OS = os;
});

test('an Android native call carries no undefined value the wrapper would forward', async () => {
    mockOnTranslateTask.mockResolvedValue({ translatedTexts: 'Hallo' });
    await expect(probeTranslationLanguage('nl')).resolves.toBe('success');
    const req = mockOnTranslateTask.mock.calls[0][0];
    const missing = ['input', 'sourceLangCode', 'targetLangCode', 'preferredStrategy', 'requiresWifi', 'requireCharging']
        .filter((key) => req[key] === undefined);
    expect(missing).toEqual([]);
});
