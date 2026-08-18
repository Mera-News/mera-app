// BackupSection — the properties that are product decisions, not styling.
//
//   1. OPT-IN. Rendering the section must not mint a key, connect an account or
//      write anything. Someone who wants no backups looks once and leaves.
//   2. THE RECOVERY CODE COMES FIRST. `runBackup` refuses until it is
//      acknowledged, so a provider-first flow would end at a button the
//      service declines.
//   3. A FAILED DRIVE CONNECT MUST NOT ADVANCE. The previous version compared a
//      result OBJECT with `!result`, which is always false, so it proceeded on
//      failure — and before that it returned a bare boolean, making a
//      misconfigured build indistinguishable from a user cancelling. That is
//      the "chooser appeared, nothing happened" report.
//   4. A CLOUD DESTINATION IS VERIFIED before setup claims success, because
//      sign-in succeeding does not prove the scope was granted.

import { fireEvent, render, waitFor } from '@testing-library/react-native';
import React from 'react';

const calls: string[] = [];

const mockEnsureBackupKey = jest.fn(async () => { calls.push('ensureBackupKey'); return 'ABCDE-FGHJK'; });
const mockMarkConfirmed = jest.fn(async () => { calls.push('markRecoveryCodeConfirmed'); });
const mockIsConfirmed = jest.fn(async () => false);
const mockAdopt = jest.fn(async (_c: string) => { calls.push('adoptRecoveryCode'); return true; });
jest.mock('@/lib/backup/key-store', () => ({
    ensureBackupKey: () => mockEnsureBackupKey(),
    markRecoveryCodeConfirmed: () => mockMarkConfirmed(),
    isRecoveryCodeConfirmed: () => mockIsConfirmed(),
    adoptRecoveryCode: (c: string) => mockAdopt(c),
    getRecoveryCode: jest.fn(async () => 'ABCDE-FGHJK'),
    clearBackupKey: jest.fn(async () => { calls.push('clearBackupKey'); }),
}));

const mockRunBackup = jest.fn(async () => {
    calls.push('runBackup');
    return { header: { tables: [{ table: 'facts', rows: 3, rowsAvailable: 3 }] }, blobBytes: 1 };
});
const mockVerifyAccess = jest.fn(async (_p?: unknown) => { calls.push('verifyProviderAccess'); });
jest.mock('@/lib/backup/backup-service', () => ({
    runBackup: () => mockRunBackup(),
    runRestore: jest.fn(async () => ({ rowsRestored: 0 })),
    listBackups: () => mockListBackups(),
    verifyProviderAccess: (p: unknown) => mockVerifyAccess(p),
}));


let mockProviderId: string | null = null;
let mockLastRunAt: number | null = null;
const mockSetProviderId = jest.fn(async (id: string) => { calls.push(`setProvider:${id}`); mockProviderId = id; });
const mockSetCadence = jest.fn(async (c: string) => { calls.push(`setCadence:${c}`); });
jest.mock('@/lib/backup/backup-settings', () => ({
    hydrateBackupSettings: jest.fn(async () => {}),
    backupProviderId: () => mockProviderId,
    backupCadence: () => 'daily',
    backupLastRunAt: () => mockLastRunAt,
    backupWifiOnly: () => true,
    setBackupProviderId: (id: string) => mockSetProviderId(id),
    setBackupCadence: (c: string) => mockSetCadence(c),
    setBackupWifiOnly: jest.fn(async () => {}),
}));

let mockConnectResult: unknown = { ok: true };
const mockConnectDrive = jest.fn(async () => { calls.push('connectGoogleDrive'); return mockConnectResult; });
jest.mock('@/lib/backup/providers/google-drive', () => ({
    connectGoogleDrive: () => mockConnectDrive(),
    googleDriveProvider: { id: 'google-drive', isAvailable: jest.fn(async () => false) },
    isGoogleDriveConfigured: () => true,
}));
let mockICloudSupported = true;
jest.mock('@/lib/backup/providers/icloud', () => ({
    icloudProvider: { id: 'icloud', isAvailable: jest.fn(async () => true) },
    isICloudSupported: () => mockICloudSupported,
}));

let mockBgAvailable = true;
jest.mock('@/lib/background/backup-task', () => ({
    backgroundBackupIsAvailable: jest.fn(async () => mockBgAvailable),
}));

const mockReload = jest.fn(async () => { calls.push('reloadApp'); });
jest.mock('expo-updates', () => ({ reloadAsync: () => mockReload() }));

const mockListBackups = jest.fn(async () => {
    calls.push('listBackups');
    return ['/mera-backup/mera-backup-2026-08-18T00-00-00-000Z.bin'];
});

jest.mock('@/lib/logger', () => ({
    __esModule: true,
    default: { captureException: jest.fn(), addBreadcrumb: jest.fn(), info: jest.fn() },
}));

jest.mock('react-native', () => {
    const actual = jest.requireActual('react-native');
    return new Proxy(actual, {
        get(target, prop) {
            if (prop === 'Share') return { share: jest.fn(async () => ({ action: 'dismissedAction' })) };
            return (target as any)[prop];
        },
    });
});

// --- chrome -----------------------------------------------------------------
jest.mock('react-native-css-interop/jsx-runtime', () => {
    const R = require('react/jsx-runtime');
    return { jsx: R.jsx, jsxs: R.jsxs, Fragment: R.Fragment };
});
jest.mock('react-native-css-interop/jsx-dev-runtime', () => {
    const R = require('react/jsx-dev-runtime');
    return { jsxDEV: R.jsxDEV, Fragment: R.Fragment };
});
const mockToastShow = jest.fn((opts: any) => { calls.push('toast'); opts.render?.(); });
jest.mock('react-i18next', () => ({ useTranslation: () => ({ t: (k: string) => k }) }));
jest.mock('@/components/ui/box', () => { const { View } = require('react-native'); return { Box: (p: any) => <View {...p} /> }; });
jest.mock('@/components/ui/vstack', () => { const { View } = require('react-native'); return { VStack: (p: any) => <View {...p} /> }; });
jest.mock('@/components/ui/text', () => { const { Text } = require('react-native'); return { Text: (p: any) => <Text {...p} /> }; });
jest.mock('@/components/ui/pressable', () => { const { Pressable } = require('react-native'); return { Pressable: (p: any) => <Pressable {...p} /> }; });
jest.mock('@/components/ui/spinner', () => { const { View } = require('react-native'); return { Spinner: (p: any) => <View {...p} /> }; });
jest.mock('@/components/ui/input', () => {
    const { View, TextInput } = require('react-native');
    return { Input: ({ children }: any) => <View>{children}</View>, InputField: (p: any) => <TextInput {...p} /> };
});
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
    const pass = ({ children }: any) => <View>{children}</View>;
    return {
        Modal: ({ children, isOpen }: any) => (isOpen ? <View>{children}</View> : null),
        ModalBackdrop: () => null, ModalContent: pass, ModalHeader: pass, ModalBody: pass, ModalFooter: pass,
    };
});
jest.mock('@/components/ui/toast', () => {
    const { View, Text } = require('react-native');
    return {
        useToast: () => ({ show: mockToastShow }),
        Toast: (p: any) => <View {...p} />,
        ToastTitle: (p: any) => <Text {...p} />,
        ToastDescription: (p: any) => <Text {...p} />,
    };
});
jest.mock('@expo/vector-icons', () => {
    const { View } = require('react-native');
    return { MaterialIcons: (p: any) => <View {...p} /> };
});

import BackupSection from '../BackupSection';

beforeEach(() => {
    jest.clearAllMocks();
    calls.length = 0;
    mockProviderId = null;
    mockLastRunAt = null;
    mockICloudSupported = true;
    mockConnectResult = { ok: true };
    mockBgAvailable = true;
    mockIsConfirmed.mockResolvedValue(false);
});

/** Walks setup as far as the "where to keep it" step. */
async function reachWhere(r: ReturnType<typeof render>) {
    await waitFor(() => r.getByTestId('backup-set-up'));
    fireEvent.press(r.getByTestId('backup-set-up'));
    await waitFor(() => r.getByTestId('backup-code-saved'));
    fireEvent.press(r.getByTestId('backup-code-saved'));
    fireEvent.press(r.getByTestId('backup-code-continue'));
    await waitFor(() => r.getByTestId('backup-pick-icloud'));
}

describe('opt-in', () => {
    it('writes nothing just from rendering the section', async () => {
        const r = render(<BackupSection />);
        await waitFor(() => r.getByTestId('backup-set-up'));
        expect(mockEnsureBackupKey).not.toHaveBeenCalled();
        expect(mockConnectDrive).not.toHaveBeenCalled();
        expect(mockRunBackup).not.toHaveBeenCalled();
        expect(mockSetCadence).not.toHaveBeenCalled();
    });
});

describe('the recovery code comes first', () => {
    it('shows the code before any destination', async () => {
        const r = render(<BackupSection />);
        await waitFor(() => r.getByTestId('backup-set-up'));
        fireEvent.press(r.getByTestId('backup-set-up'));
        await waitFor(() => r.getByTestId('backup-code-continue'));
        expect(r.queryByTestId('backup-pick-file')).toBeNull();
        expect(r.queryByTestId('backup-pick-icloud')).toBeNull();
    });

    it('will not continue until the user says they have saved it', async () => {
        const r = render(<BackupSection />);
        await waitFor(() => r.getByTestId('backup-set-up'));
        fireEvent.press(r.getByTestId('backup-set-up'));
        await waitFor(() => r.getByTestId('backup-code-continue'));
        fireEvent.press(r.getByTestId('backup-code-continue'));
        expect(mockMarkConfirmed).not.toHaveBeenCalled();
    });

    it('acknowledges the code strictly before a destination is recorded', async () => {
        const r = render(<BackupSection />);
        await reachWhere(r);
        fireEvent.press(r.getByTestId('backup-pick-icloud'));
        await waitFor(() => expect(mockSetProviderId).toHaveBeenCalledWith('icloud'));
        expect(calls.indexOf('markRecoveryCodeConfirmed')).toBeLessThan(calls.indexOf('setProvider:icloud'));
    });
});

describe('the destination list', () => {

    it('does not render iCloud at all on a platform that can never support it', async () => {
        mockICloudSupported = false;
        const r = render(<BackupSection />);
        await waitFor(() => r.getByTestId('backup-set-up'));
        fireEvent.press(r.getByTestId('backup-set-up'));
        await waitFor(() => r.getByTestId('backup-code-saved'));
        fireEvent.press(r.getByTestId('backup-code-saved'));
        fireEvent.press(r.getByTestId('backup-code-continue'));
        // Anchored on the Drive row, since the whole point is that the iCloud
        // one is absent: a permanently greyed-out option is noise, not a choice.
        await waitFor(() => r.getByTestId('backup-pick-drive'));
        expect(r.queryByTestId('backup-pick-icloud')).toBeNull();
    });

    it('still renders iCloud where the platform supports it', async () => {
        const r = render(<BackupSection />);
        await reachWhere(r);
        r.getByTestId('backup-pick-icloud');
    });
});

describe('setting up a cloud destination', () => {
    it('offers a cadence for a cloud destination', async () => {
        const r = render(<BackupSection />);
        await reachWhere(r);
        fireEvent.press(r.getByTestId('backup-pick-icloud'));
        await waitFor(() => r.getByTestId('backup-cadence-daily'));
    });

    it('verifies real access before declaring a cloud destination set up', async () => {
        const r = render(<BackupSection />);
        await reachWhere(r);
        fireEvent.press(r.getByTestId('backup-pick-icloud'));
        await waitFor(() => expect(mockVerifyAccess).toHaveBeenCalled());
        // Sign-in succeeding does not prove the grant landed; a token without
        // the scope fails nothing until a background task nobody is watching.
        expect(calls.indexOf('verifyProviderAccess')).toBeLessThan(calls.indexOf('setProvider:icloud'));
    });

});

describe('a failed Drive connect must not advance', () => {
    it('reports a misconfigured build and records no provider', async () => {
        // The exact reported symptom: chooser appears, sign-in completes,
        // nothing happens. `!result` on an object is always false.
        mockConnectResult = { ok: false, reason: 'misconfigured', detail: 'DEVELOPER_ERROR' };
        const r = render(<BackupSection />);
        await reachWhere(r);
        fireEvent.press(r.getByTestId('backup-pick-drive'));
        await waitFor(() => expect(mockConnectDrive).toHaveBeenCalled());
        expect(mockSetProviderId).not.toHaveBeenCalled();
        expect(mockVerifyAccess).not.toHaveBeenCalled();
        expect(calls).toContain('toast');
    });

    it('stays silent when the user simply cancels', async () => {
        mockConnectResult = { ok: false, reason: 'cancelled' };
        const r = render(<BackupSection />);
        await reachWhere(r);
        fireEvent.press(r.getByTestId('backup-pick-drive'));
        await waitFor(() => expect(mockConnectDrive).toHaveBeenCalled());
        expect(mockSetProviderId).not.toHaveBeenCalled();
        // Cancelling is a choice, not an error to shout about.
        expect(calls).not.toContain('toast');
    });

    it('reports missing Play services distinctly', async () => {
        mockConnectResult = { ok: false, reason: 'play-services' };
        const r = render(<BackupSection />);
        await reachWhere(r);
        fireEvent.press(r.getByTestId('backup-pick-drive'));
        await waitFor(() => expect(calls).toContain('toast'));
        expect(mockSetProviderId).not.toHaveBeenCalled();
    });
});

describe('the new-phone path', () => {
    it('is reachable with backup off, because a fresh install has no key', async () => {
        const r = render(<BackupSection />);
        await waitFor(() => r.getByTestId('backup-already-have'));
        fireEvent.press(r.getByTestId('backup-already-have'));
        await waitFor(() => r.getByTestId('backup-code-input'));
    });

    it('lands on the RESTORE picker, not the setup picker', async () => {
        // The bug this pins, found on device: adopting a code dropped the user
        // into "where should backups go" and quietly configured backup, so the
        // restore never ran. "Where is my backup" and "where should backups go"
        // are different questions and need different screens.
        const r = render(<BackupSection />);
        await waitFor(() => r.getByTestId('backup-already-have'));
        fireEvent.press(r.getByTestId('backup-already-have'));
        await waitFor(() => r.getByTestId('backup-code-input'));
        fireEvent.changeText(r.getByTestId('backup-code-input'), 'abcde fghjk');
        fireEvent.press(r.getByTestId('backup-adopt-continue'));
        await waitFor(() => expect(mockAdopt).toHaveBeenCalledWith('abcde fghjk'));

        await waitFor(() => r.getByTestId('backup-restore-from-icloud'));
        expect(r.queryByTestId('backup-pick-icloud')).toBeNull();
        // And nothing has been configured as a backup destination yet.
        expect(mockSetProviderId).not.toHaveBeenCalled();
        expect(mockSetCadence).not.toHaveBeenCalled();
    });

    it('lists what is actually there, then restores and RELOADS the app', async () => {
        const r = render(<BackupSection />);
        await waitFor(() => r.getByTestId('backup-already-have'));
        fireEvent.press(r.getByTestId('backup-already-have'));
        await waitFor(() => r.getByTestId('backup-code-input'));
        fireEvent.changeText(r.getByTestId('backup-code-input'), 'code');
        fireEvent.press(r.getByTestId('backup-adopt-continue'));
        await waitFor(() => r.getByTestId('backup-restore-from-icloud'));

        fireEvent.press(r.getByTestId('backup-restore-from-icloud'));
        await waitFor(() => expect(mockListBackups).toHaveBeenCalled());

        fireEvent.press(r.getByText('mera-backup-2026-08-18T00-00-00-000Z.bin'));
        await waitFor(() => r.getByTestId('backup-restore-confirm'));
        fireEvent.press(r.getByTestId('backup-restore-confirm'));

        // The restore replaced rows under every Zustand store, all of which
        // hydrated at startup. Without a reload the user is told "restored" and
        // shown the empty persona they already had.
        await waitFor(() => expect(calls).toContain('reloadApp'));
        expect(mockSetProviderId).toHaveBeenCalledWith('icloud');
    });

    it('says the code is wrong and stays put', async () => {
        mockAdopt.mockResolvedValueOnce(false);
        const r = render(<BackupSection />);
        await waitFor(() => r.getByTestId('backup-already-have'));
        fireEvent.press(r.getByTestId('backup-already-have'));
        await waitFor(() => r.getByTestId('backup-code-input'));
        fireEvent.changeText(r.getByTestId('backup-code-input'), 'nope');
        fireEvent.press(r.getByTestId('backup-adopt-continue'));
        await waitFor(() => expect(calls).toContain('toast'));
        r.getByTestId('backup-code-input');
    });
});

describe('the configured state', () => {




    it('says plainly when the OS will not run background work', async () => {
        // Silence here would leave the user believing in a schedule they do not
        // have: Background App Refresh off means backups never run on their own.
        mockBgAvailable = false;
        mockProviderId = 'icloud';
        mockIsConfirmed.mockResolvedValue(true);
        const r = render(<BackupSection />);
        await waitFor(() => r.getByText('backup.backgroundRestricted'));
    });

    it('says backups run in the background when the OS allows it', async () => {
        mockProviderId = 'icloud';
        mockIsConfirmed.mockResolvedValue(true);
        const r = render(<BackupSection />);
        await waitFor(() => r.getByText('backup.runsInBackground'));
    });

    it('lets the schedule be changed after setup', async () => {
        // It could not be: the cadence picker only existed in the setup flow,
        // so whatever was chosen once was permanent.
        mockProviderId = 'icloud';
        mockIsConfirmed.mockResolvedValue(true);
        const r = render(<BackupSection />);
        await waitFor(() => r.getByTestId('backup-change-schedule'));
        fireEvent.press(r.getByTestId('backup-change-schedule'));
        await waitFor(() => r.getByTestId('backup-cadence-weekly'));
        fireEvent.press(r.getByTestId('backup-cadence-weekly'));
        await waitFor(() => expect(mockSetCadence).toHaveBeenCalledWith('weekly'));
    });

    it('forgets the key when backup is turned off, and only after confirming', async () => {
        mockProviderId = 'icloud';
        mockIsConfirmed.mockResolvedValue(true);
        const r = render(<BackupSection />);
        await waitFor(() => r.getByTestId('backup-turn-off'));
        fireEvent.press(r.getByTestId('backup-turn-off'));
        expect(calls).not.toContain('clearBackupKey');
        await waitFor(() => r.getByTestId('backup-turn-off-confirm'));
        fireEvent.press(r.getByTestId('backup-turn-off-confirm'));
        await waitFor(() => expect(calls).toContain('clearBackupKey'));
        expect(calls).toContain('setCadence:off');
    });
});
