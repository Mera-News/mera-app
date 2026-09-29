import { act, fireEvent, render } from '@testing-library/react-native';
import React from 'react';

jest.mock('react-i18next', () => ({
    useTranslation: () => ({ t: (key: string) => key }),
}));

let mockIsDevice = true;
jest.mock('expo-device', () => ({
    get isDevice() {
        return mockIsDevice;
    },
    modelName: 'M2101K6G',
    osVersion: '13',
    totalMemory: 5.7 * 1024 * 1024 * 1024,
}));

jest.mock('@/components/custom/auth/LanguageSelector', () => () => null);
jest.mock('@/components/custom/MeraLogo', () => () => null);
jest.mock('@/components/custom/system-check/CheckRing', () => ({ children }: { children: React.ReactNode }) => children);
jest.mock('@/lib/haptics', () => ({ hapticLight: jest.fn() }));

const mockRequestSwitch = jest.fn();
jest.mock('@/lib/hooks/use-language-switch', () => ({
    useLanguageSwitch: () => ({ requestSwitch: mockRequestSwitch, busy: false }),
}));

let mockAppLanguage = 'nl';
const mockSetAppLanguage = jest.fn(() => Promise.resolve());
jest.mock('@/lib/stores/app-language-store', () => {
    const useAppLanguageStore = (sel: (s: { appLanguage: string }) => unknown) => sel({ appLanguage: mockAppLanguage });
    useAppLanguageStore.getState = () => ({ appLanguage: mockAppLanguage, setAppLanguage: mockSetAppLanguage });
    return { useAppLanguageStore };
});

jest.mock('@/lib/stores/display-prefs-store', () => ({
    useDisplayPrefsStore: (sel: (s: { liteMode: boolean }) => unknown) => sel({ liteMode: true }),
}));

let mockVerified = false;
let mockBlocked = false;
const mockProbe = jest.fn(() => Promise.resolve('failed'));
jest.mock('@/lib/translation-service', () => ({
    getNativeLanguageName: (code: string) => code,
    isTranslationVerified: () => mockVerified,
    probeTranslationLanguage: (...args: unknown[]) => mockProbe(...(args as [])),
    subscribeTranslationAvailability: () => () => {},
    useTranslationBlocked: () => (mockBlocked ? { reason: 'x' } : null),
}));

import SystemCheckStage from '../SystemCheckStage';

function renderSettled(onContinue = jest.fn()) {
    const r = render(<SystemCheckStage onContinue={onContinue} testID="sc" />);
    // Each step's timer is armed by the render that finished the previous one.
    for (let i = 0; i < 3; i++) {
        act(() => {
            jest.advanceTimersByTime(460);
        });
    }
    return { ...r, onContinue };
}

describe('SystemCheckStage', () => {
    beforeEach(() => {
        jest.useFakeTimers();
        jest.clearAllMocks();
        mockIsDevice = true;
        mockAppLanguage = 'nl';
        mockVerified = false;
        mockBlocked = false;
    });
    afterEach(() => jest.useRealTimers());

    it('says Lite mode and that on-device AI is not available yet', () => {
        const { getByText } = renderSettled();
        expect(getByText('systemCheck.modeLite')).toBeTruthy();
        expect(getByText('systemCheck.aiNotYet')).toBeTruthy();
    });

    it('keeps Continue closed while the language pack is unverified', () => {
        const { getByTestId, onContinue } = renderSettled();
        expect(getByTestId('sc-continue').props.accessibilityState.disabled).toBe(true);
        fireEvent.press(getByTestId('sc-continue'));
        expect(onContinue).not.toHaveBeenCalled();
    });

    it('opens Continue once the pack is verified, and persists the language', async () => {
        mockVerified = true;
        const { getByTestId, onContinue } = renderSettled();
        expect(getByTestId('sc-continue').props.accessibilityState.disabled).toBe(false);
        await act(async () => {
            fireEvent.press(getByTestId('sc-continue'));
        });
        expect(mockSetAppLanguage).toHaveBeenCalledWith('nl');
        expect(onContinue).toHaveBeenCalledTimes(1);
    });

    it('still advances when persisting the language fails (next launch asks again)', async () => {
        mockVerified = true;
        mockSetAppLanguage.mockRejectedValueOnce(new Error('db closed'));
        const { getByTestId, onContinue } = renderSettled();
        await act(async () => {
            fireEvent.press(getByTestId('sc-continue'));
        });
        expect(onContinue).toHaveBeenCalledTimes(1);
    });

    it('a failed pack offers only Try again and Use English, never a way past', () => {
        mockBlocked = true;
        const { getByTestId } = renderSettled();
        expect(getByTestId('sc-continue').props.accessibilityState.disabled).toBe(true);
        fireEvent.press(getByTestId('sc-use-english'));
        expect(mockRequestSwitch).toHaveBeenCalledWith('en');
        fireEvent.press(getByTestId('sc-retry'));
        expect(mockProbe).toHaveBeenCalledWith('nl');
    });

    it('a simulator can only continue in English, even with a verified pack', () => {
        mockIsDevice = false;
        mockVerified = true;
        const { getByTestId } = renderSettled();
        expect(getByTestId('sc-continue').props.accessibilityState.disabled).toBe(true);
        expect(getByTestId('sc-use-english')).toBeTruthy();
    });

    it('English passes straight away', () => {
        mockAppLanguage = 'en';
        const { getByTestId, queryByTestId } = renderSettled();
        expect(getByTestId('sc-continue').props.accessibilityState.disabled).toBe(false);
        expect(queryByTestId('sc-use-english')).toBeNull();
    });
});
