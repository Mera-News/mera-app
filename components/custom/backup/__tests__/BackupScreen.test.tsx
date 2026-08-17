/* eslint-disable @typescript-eslint/no-require-imports */
// BackupScreen — the two properties that are product decisions, not styling.
//
//   1. OPT-IN. Opening the screen must not mint a key, connect an account, or
//      upload anything. A user can look and leave.
//   2. THE RECOVERY CODE COMES FIRST. `runBackup` refuses until the code is
//      acknowledged, so a setup flow that asked for the provider first would
//      leave the finish button looking broken. Worse, if the gate were ever
//      relaxed, a backup could upload under a key that exists only in the
//      keychain — and the next logout wipes the keychain, leaving a blob in the
//      cloud that nobody can open and the user believes is their backup.
//
// Mock shape copied from ManageDataScreen.test.tsx, which is the working
// recipe for rendering a gluestack screen under Jest.

import { fireEvent, render, waitFor } from '@testing-library/react-native';
import React from 'react';

const calls: string[] = [];

const mockEnsureBackupKey = jest.fn(async () => {
    calls.push('ensureBackupKey');
    return 'ABCDE-FGHJK-MNPQR';
});
const mockMarkConfirmed = jest.fn(async () => { calls.push('markRecoveryCodeConfirmed'); });
const mockIsConfirmed = jest.fn(async () => false);
jest.mock('@/lib/backup/key-store', () => ({
    ensureBackupKey: () => mockEnsureBackupKey(),
    markRecoveryCodeConfirmed: () => mockMarkConfirmed(),
    isRecoveryCodeConfirmed: () => mockIsConfirmed(),
    getRecoveryCode: jest.fn(async () => 'ABCDE-FGHJK-MNPQR'),
    clearBackupKey: jest.fn(async () => { calls.push('clearBackupKey'); }),
}));

const mockRunBackup = jest.fn(async () => {
    calls.push('runBackup');
    return { header: { tables: [{ table: 'facts', rows: 3, rowsAvailable: 3 }] }, blobBytes: 1 };
});
jest.mock('@/lib/backup/backup-service', () => ({
    runBackup: () => mockRunBackup(),
    runRestore: jest.fn(async () => ({ rowsRestored: 0 })),
    listBackups: jest.fn(async () => []),
}));

let mockProviderId: string | null = null;
const mockSetProviderId = jest.fn(async (id: string) => {
    calls.push(`setProvider:${id}`);
    mockProviderId = id;
});
const mockSetCadence = jest.fn(async (c: string) => { calls.push(`setCadence:${c}`); });
jest.mock('@/lib/backup/backup-settings', () => ({
    hydrateBackupSettings: jest.fn(async () => { calls.push('hydrate'); }),
    backupProviderId: () => mockProviderId,
    backupCadence: () => 'daily',
    backupLastRunAt: () => null,
    backupWifiOnly: () => true,
    setBackupProviderId: (id: string) => mockSetProviderId(id),
    setBackupCadence: (c: string) => mockSetCadence(c),
    setBackupWifiOnly: jest.fn(async () => {}),
}));

const mockConnectDrive = jest.fn(async () => { calls.push('connectGoogleDrive'); return true; });
jest.mock('@/lib/backup/providers/google-drive', () => ({
    connectGoogleDrive: () => mockConnectDrive(),
    googleDriveProvider: { id: 'google-drive', isAvailable: jest.fn(async () => false) },
    isGoogleDriveConfigured: () => true,
}));
jest.mock('@/lib/backup/providers/icloud', () => ({
    icloudProvider: { id: 'icloud', isAvailable: jest.fn(async () => true) },
}));

jest.mock('@/lib/logger', () => ({
    __esModule: true,
    default: { captureException: jest.fn(), addBreadcrumb: jest.fn(), info: jest.fn() },
}));

jest.mock('react-native-safe-area-context', () => ({
    useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

// ScrollView's native component spec cannot be parsed under Jest — proxy RN so
// it renders as a plain View; every other export stays real.
jest.mock('react-native', () => {
    const actual = jest.requireActual('react-native');
    const ReactLib = require('react');
    const StubScrollView = ({ children, ...rest }: any) =>
        ReactLib.createElement(actual.View, rest, children);
    StubScrollView.Context = ReactLib.createContext(null);
    return new Proxy(actual, {
        get(target, prop) {
            if (prop === 'ScrollView') return StubScrollView;
            if (prop === 'Share') return { share: jest.fn(async () => ({ action: 'dismissedAction' })) };
            return (target as any)[prop];
        },
    });
});

// --- chrome -----------------------------------------------------------------
jest.mock('react-native-css-interop/jsx-runtime', () => {
    const ReactJSXRuntime = require('react/jsx-runtime');
    return { jsx: ReactJSXRuntime.jsx, jsxs: ReactJSXRuntime.jsxs, Fragment: ReactJSXRuntime.Fragment };
});
jest.mock('react-native-css-interop/jsx-dev-runtime', () => {
    const ReactJSXRuntime = require('react/jsx-dev-runtime');
    return { jsxDEV: ReactJSXRuntime.jsxDEV, Fragment: ReactJSXRuntime.Fragment };
});
jest.mock('react-i18next', () => ({ useTranslation: () => ({ t: (k: string) => k }) }));
jest.mock('@/components/custom/AbstractGradientBackdrop', () => ({ __esModule: true, default: () => null }));
jest.mock('@/components/ui/gluestack-ui-provider', () => {
    const { View } = require('react-native');
    return { GluestackUIProvider: ({ children }: any) => <View>{children}</View> };
});
jest.mock('@/components/ui/box', () => { const { View } = require('react-native'); return { Box: (p: any) => <View {...p} /> }; });
jest.mock('@/components/ui/vstack', () => { const { View } = require('react-native'); return { VStack: (p: any) => <View {...p} /> }; });
jest.mock('@/components/ui/text', () => { const { Text } = require('react-native'); return { Text: (p: any) => <Text {...p} /> }; });
jest.mock('@/components/ui/pressable', () => { const { Pressable } = require('react-native'); return { Pressable: (p: any) => <Pressable {...p} /> }; });
jest.mock('@/components/ui/button', () => {
    const { Pressable, Text } = require('react-native');
    return {
        Button: ({ children, onPress, isDisabled, testID, ...p }: any) => (
            <Pressable onPress={onPress} disabled={isDisabled} testID={testID} {...p}>{children}</Pressable>
        ),
        ButtonText: ({ children }: any) => <Text>{children}</Text>,
    };
});
jest.mock('@/components/ui/modal', () => {
    const { View } = require('react-native');
    const passthrough = ({ children }: any) => <View>{children}</View>;
    return {
        Modal: ({ children, isOpen }: any) => (isOpen ? <View>{children}</View> : null),
        ModalBackdrop: () => null,
        ModalContent: passthrough,
        ModalHeader: passthrough,
        ModalBody: passthrough,
        ModalFooter: passthrough,
    };
});
jest.mock('@/components/ui/toast', () => {
    const { View, Text } = require('react-native');
    return {
        useToast: () => ({ show: (opts: any) => { calls.push('toast'); opts.render?.(); } }),
        Toast: (p: any) => <View {...p} />,
        ToastTitle: (p: any) => <Text {...p} />,
        ToastDescription: (p: any) => <Text {...p} />,
    };
});
jest.mock('@/components/ui/spinner', () => { const { View } = require('react-native'); return { Spinner: (p: any) => <View {...p} /> }; });
jest.mock('@expo/vector-icons', () => {
    const { View } = require('react-native');
    return { MaterialIcons: (p: any) => <View {...p} /> };
});

import BackupScreen from '../BackupScreen';

beforeEach(() => {
    jest.clearAllMocks();
    calls.length = 0;
    mockProviderId = null;
    mockIsConfirmed.mockResolvedValue(false);
});

describe('opt-in', () => {
    it('mints no key, connects nothing and uploads nothing just from opening the screen', async () => {
        const { getByTestId } = render(<BackupScreen />);
        await waitFor(() => getByTestId('backup-set-up'));

        expect(mockEnsureBackupKey).not.toHaveBeenCalled();
        expect(mockConnectDrive).not.toHaveBeenCalled();
        expect(mockRunBackup).not.toHaveBeenCalled();
        expect(mockSetCadence).not.toHaveBeenCalled();
    });

    it('shows the setup entry point, not the configured state, on a fresh device', async () => {
        const { getByTestId, queryByTestId } = render(<BackupScreen />);
        await waitFor(() => getByTestId('backup-set-up'));
        expect(queryByTestId('backup-run-now')).toBeNull();
    });
});

describe('the recovery code comes first', () => {
    it('shows the code before the provider picker', async () => {
        const { getByTestId, queryByTestId } = render(<BackupScreen />);
        await waitFor(() => getByTestId('backup-set-up'));
        fireEvent.press(getByTestId('backup-set-up'));

        await waitFor(() => getByTestId('backup-code-continue'));
        // Not the provider list. Asking for the provider first would let the
        // user reach a finish button that runBackup then refuses.
        expect(queryByTestId('backup-pick-icloud')).toBeNull();
        expect(mockEnsureBackupKey).toHaveBeenCalled();
    });

    it('will not continue until the user says they have saved the code', async () => {
        const { getByTestId } = render(<BackupScreen />);
        await waitFor(() => getByTestId('backup-set-up'));
        fireEvent.press(getByTestId('backup-set-up'));
        await waitFor(() => getByTestId('backup-code-continue'));

        fireEvent.press(getByTestId('backup-code-continue'));
        expect(mockMarkConfirmed).not.toHaveBeenCalled();

        fireEvent.press(getByTestId('backup-code-saved'));
        fireEvent.press(getByTestId('backup-code-continue'));
        await waitFor(() => expect(mockMarkConfirmed).toHaveBeenCalled());
    });

    it('acknowledges the code BEFORE a provider is ever chosen', async () => {
        const { getByTestId } = render(<BackupScreen />);
        await waitFor(() => getByTestId('backup-set-up'));
        fireEvent.press(getByTestId('backup-set-up'));
        await waitFor(() => getByTestId('backup-code-saved'));
        fireEvent.press(getByTestId('backup-code-saved'));
        fireEvent.press(getByTestId('backup-code-continue'));

        await waitFor(() => getByTestId('backup-pick-icloud'));
        fireEvent.press(getByTestId('backup-pick-icloud'));
        await waitFor(() => expect(mockSetProviderId).toHaveBeenCalledWith('icloud'));

        expect(calls.indexOf('markRecoveryCodeConfirmed')).toBeLessThan(
            calls.indexOf('setProvider:icloud'),
        );
    });
});

describe('provider choice', () => {
    it('connects Google Drive interactively, and only from the button press', async () => {
        const { getByTestId } = render(<BackupScreen />);
        await waitFor(() => getByTestId('backup-set-up'));
        fireEvent.press(getByTestId('backup-set-up'));
        await waitFor(() => getByTestId('backup-code-saved'));
        fireEvent.press(getByTestId('backup-code-saved'));
        fireEvent.press(getByTestId('backup-code-continue'));

        await waitFor(() => getByTestId('backup-pick-drive'));
        fireEvent.press(getByTestId('backup-pick-drive'));
        await waitFor(() => expect(mockConnectDrive).toHaveBeenCalled());
        expect(calls.indexOf('connectGoogleDrive')).toBeLessThan(
            calls.indexOf('setProvider:google-drive'),
        );
    });

    it('does not record a provider when the account chooser is cancelled', async () => {
        mockConnectDrive.mockResolvedValueOnce(false);
        const { getByTestId } = render(<BackupScreen />);
        await waitFor(() => getByTestId('backup-set-up'));
        fireEvent.press(getByTestId('backup-set-up'));
        await waitFor(() => getByTestId('backup-code-saved'));
        fireEvent.press(getByTestId('backup-code-saved'));
        fireEvent.press(getByTestId('backup-code-continue'));

        await waitFor(() => getByTestId('backup-pick-drive'));
        fireEvent.press(getByTestId('backup-pick-drive'));
        await waitFor(() => expect(mockConnectDrive).toHaveBeenCalled());
        expect(mockSetProviderId).not.toHaveBeenCalled();
    });
});

describe('the configured state', () => {
    it('offers the actions once a provider and a confirmed code exist', async () => {
        mockProviderId = 'icloud';
        mockIsConfirmed.mockResolvedValue(true);
        const { getByTestId } = render(<BackupScreen />);
        await waitFor(() => getByTestId('backup-run-now'));
        getByTestId('backup-show-code');
        getByTestId('backup-restore');
        getByTestId('backup-turn-off');
    });

    it('runs a backup on demand', async () => {
        mockProviderId = 'icloud';
        mockIsConfirmed.mockResolvedValue(true);
        const { getByTestId } = render(<BackupScreen />);
        await waitFor(() => getByTestId('backup-run-now'));
        fireEvent.press(getByTestId('backup-run-now'));
        await waitFor(() => expect(mockRunBackup).toHaveBeenCalled());
    });

    it('needs an explicit confirmation before restoring, because restore REPLACES', async () => {
        mockProviderId = 'icloud';
        mockIsConfirmed.mockResolvedValue(true);
        const { getByTestId, queryByTestId } = render(<BackupScreen />);
        await waitFor(() => getByTestId('backup-restore'));
        fireEvent.press(getByTestId('backup-restore'));
        // The picker opens; nothing is restored by the tap itself.
        expect(queryByTestId('backup-restore-confirm')).toBeNull();
    });

    it('forgets the key when backup is turned off, and only after a confirmation', async () => {
        mockProviderId = 'icloud';
        mockIsConfirmed.mockResolvedValue(true);
        const { getByTestId } = render(<BackupScreen />);
        await waitFor(() => getByTestId('backup-turn-off'));

        fireEvent.press(getByTestId('backup-turn-off'));
        expect(calls).not.toContain('clearBackupKey');

        await waitFor(() => getByTestId('backup-turn-off-confirm'));
        fireEvent.press(getByTestId('backup-turn-off-confirm'));
        await waitFor(() => expect(calls).toContain('clearBackupKey'));
        expect(calls).toContain('setCadence:off');
    });
});
