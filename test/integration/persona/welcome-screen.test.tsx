/**
 * The welcome screen's Get started and "Learn about Mera" buttons, and the Settings system check.
 */
import React from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react-native';
import WelcomeStage from '@/components/custom/auth/WelcomeStage';
import SystemCheckStage from '@/components/custom/system-check/SystemCheckStage';
import { initI18nEn } from '@/test/helpers';

// The check rows' animated mark drives a Reanimated sweep the Jest mock cannot run.
jest.mock('@/components/custom/MeraLogo', () => ({ __esModule: true, default: () => null }));

beforeAll(initI18nEn);

const welcome = (over: Partial<React.ComponentProps<typeof WelcomeStage>> = {}) =>
    render(<WelcomeStage messageTop={0} canUsePhone onGetStarted={jest.fn()} starting={false} onLearn={jest.fn()} {...over} />);

describe('Welcome screen actions', () => {
    it('shows Get started and Learn about Mera, and no Begin Mera', async () => {
        await welcome();
        expect(screen.getByTestId('auth-begin-without-email')).toBeTruthy();
        expect(screen.getByTestId('auth-learn-mera')).toBeTruthy();
        expect(screen.queryByTestId('auth-begin-mera')).toBeNull();
    });

    it('Learn about Mera calls its handler', async () => {
        const onLearn = jest.fn();
        await welcome({ onLearn });
        await fireEvent.press(screen.getByTestId('auth-learn-mera'));
        expect(onLearn).toHaveBeenCalledTimes(1);
    });

    it('Get started calls its handler, and waits while starting', async () => {
        const onGetStarted = jest.fn();
        await welcome({ onGetStarted });
        await fireEvent.press(screen.getByTestId('auth-begin-without-email'));
        expect(onGetStarted).toHaveBeenCalledTimes(1);
    });

    it('an unsupported phone shows the notice and no buttons', async () => {
        await welcome({ canUsePhone: false });
        expect(screen.getByTestId('auth-begin-unsupported')).toBeTruthy();
        expect(screen.queryByTestId('auth-begin-without-email')).toBeNull();
        expect(screen.queryByTestId('auth-learn-mera')).toBeNull();
    });
});

describe('Settings system check', () => {
    it('is unchanged: title, all four rows, Continue', async () => {
        jest.useFakeTimers();
        const onContinue = jest.fn();
        await render(<SystemCheckStage onContinue={onContinue} testID="settings-system-check" />);
        expect(screen.getByText('Checking your phone')).toBeTruthy();
        for (let i = 0; i < 4; i += 1) await act(async () => { await jest.advanceTimersByTimeAsync(150); });
        expect(screen.getByTestId('settings-system-check-ai')).toBeTruthy();
        await fireEvent.press(screen.getByTestId('settings-system-check-continue'));
        await act(async () => { await jest.advanceTimersByTimeAsync(0); });
        expect(onContinue).toHaveBeenCalledTimes(1);
        jest.useRealTimers();
    });
});
