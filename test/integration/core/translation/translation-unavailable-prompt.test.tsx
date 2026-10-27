// TranslationUnavailablePrompt: a breaker block (retryable) shows NO notice, because each
// failed text carries its own glyph and tooltip; a permanent block (no translator for the
// language on this iOS, or none on the device) still shows its notice, the only explanation
// those texts get. The toast host is faked at its edge.
import React from 'react';
import { render, screen, waitFor } from '@testing-library/react-native';
import TranslationUnavailablePrompt from '@/components/custom/TranslationUnavailablePrompt';
import { initI18nEn } from '@/test/helpers';

type Block = { permanent: boolean; deviceUnsupported: boolean } | null;
let mockBlock: Block = null;
let mockVerified = true;
const mockNoteLaunchVerifyFailed = jest.fn(async (_code: string) => {});
jest.mock('@/lib/translation-service', () => ({
    ...jest.requireActual('@/lib/translation-service'),
    useTranslationBlocked: () => mockBlock,
    isTranslationVerified: () => mockVerified,
    noteLaunchVerifyFailed: (code: string) => mockNoteLaunchVerifyFailed(code),
}));
jest.mock('@/lib/stores/app-language-store', () => ({ useAppLanguage: () => 'de' }));
let mockProbeOutcome = 'success';
jest.mock('@/lib/hooks/use-language-switch', () => ({ probeLanguage: jest.fn(async () => mockProbeOutcome) }));
jest.mock('expo-router', () => ({ usePathname: () => '/logged-in' }));

const mockShow = jest.fn();
jest.mock('@/components/ui/toast', () => ({
    useToast: () => ({ show: mockShow, close: jest.fn(), isActive: () => false }),
    useIsToastFront: () => true,
}));

const shown = () => {
    const opts = mockShow.mock.calls.at(-1)?.[0] as { render: () => React.ReactElement };
    render(opts.render());
};

beforeAll(initI18nEn);
beforeEach(() => {
    mockShow.mockClear();
    mockBlock = null;
    mockVerified = true;
    mockProbeOutcome = 'success';
    mockNoteLaunchVerifyFailed.mockClear();
});

it('hands a failed or timed-out launch re-verify to the service, and nothing else', async () => {
    mockVerified = false;
    mockProbeOutcome = 'timeout';
    render(<TranslationUnavailablePrompt />);
    await waitFor(() => expect(mockNoteLaunchVerifyFailed).toHaveBeenCalledWith('de'));
});

it('a successful launch re-verify does not touch the breaker', async () => {
    mockVerified = false;
    mockProbeOutcome = 'success';
    const { probeLanguage } = jest.requireMock('@/lib/hooks/use-language-switch') as { probeLanguage: jest.Mock };
    probeLanguage.mockClear();
    render(<TranslationUnavailablePrompt />);
    await waitFor(() => expect(probeLanguage).toHaveBeenCalled());
    await new Promise((r) => setImmediate(r));
    expect(mockNoteLaunchVerifyFailed).not.toHaveBeenCalled();
});

it('a breaker block (the pack may still be downloading) shows no notice', () => {
    mockBlock = { permanent: false, deviceUnsupported: false };
    render(<TranslationUnavailablePrompt />);
    expect(mockShow).not.toHaveBeenCalled();
});

it('a language this iOS cannot translate still shows its notice, with no action', () => {
    mockBlock = { permanent: true, deviceUnsupported: false };
    render(<TranslationUnavailablePrompt />);
    expect(mockShow).toHaveBeenCalledTimes(1);
    shown();
    expect(screen.getByText('Translation unavailable')).toBeTruthy();
    expect(screen.queryByRole('button')).toBeNull();
});

it('a device with no translator still shows its notice', () => {
    mockBlock = { permanent: true, deviceUnsupported: true };
    render(<TranslationUnavailablePrompt />);
    expect(mockShow).toHaveBeenCalledTimes(1);
});
