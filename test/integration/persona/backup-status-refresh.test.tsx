/** The backup status card follows the settings mirror after a run, a failure and a settings change. */
import { act, fireEvent, render, screen } from '@testing-library/react-native';
import React from 'react';
import BackupSection from '@/components/custom/backup/BackupSection';
import { resetBackupSettingsMirror } from '@/lib/backup/backup-settings';
import { runBackup } from '@/lib/backup/backup-service';
import { initI18nEn } from '@/test/helpers';

// RN Modal pulls an untransformed native spec in jest.
jest.mock('react-native/Libraries/Modal/Modal', () => {
    const { View } = jest.requireActual('react-native');
    return {
        __esModule: true,
        default: ({ visible, children }: { visible?: boolean; children?: React.ReactNode }) => (visible ? <View>{children}</View> : null),
    };
});

const mockStore = new Map<string, string>();
jest.mock('@/lib/database/services/setting-service', () => ({
    getSetting: jest.fn(async (k: string) => mockStore.get(k) ?? null),
    setSetting: jest.fn(async (k: string, v: string) => void mockStore.set(k, v)),
}));
jest.mock('@/lib/backup/backup-service', () => ({
    runBackup: jest.fn(),
    runRestore: jest.fn(),
    listBackups: jest.fn(async () => []),
    verifyProviderAccess: jest.fn(async () => undefined),
}));
jest.mock('@/lib/backup/key-store', () => ({
    isBackupConfigured: jest.fn(async () => true),
    ensureBackupKey: jest.fn(),
    clearBackupKey: jest.fn(),
    getRecoveryCode: jest.fn(),
    adoptRecoveryCode: jest.fn(),
    markRecoveryCodeConfirmed: jest.fn(),
}));
jest.mock('@/lib/backup/providers/icloud', () => ({
    icloudProvider: { isAvailable: async () => true },
    isICloudSupported: () => true,
}));
jest.mock('@/lib/backup/providers/google-drive', () => ({
    googleDriveProvider: { isAvailable: async () => false },
    isGoogleDriveConfigured: () => false,
    connectGoogleDrive: jest.fn(),
}));
jest.mock('@/lib/background/backup-task', () => ({ backgroundBackupIsAvailable: async () => true }));
jest.mock('@/lib/toast-manager', () => ({
    toastManager: { showError: jest.fn(), showSuccess: jest.fn(), showInfo: jest.fn() },
}));

const run = jest.mocked(runBackup);
beforeAll(initI18nEn);
beforeEach(() => {
    mockStore.clear();
    resetBackupSettingsMirror();
    mockStore.set('backup_provider', 'icloud');
    mockStore.set('backup_cadence', 'daily');
    run.mockReset();
});

const pressRun = async () => {
    await act(async () => {
        fireEvent.press(screen.getByTestId('backup-run-now'));
    });
};

describe('BackupSection status card', () => {
    it('shows the new time after a successful run', async () => {
        run.mockResolvedValue({ header: { createdAt: Date.now(), tables: [] } } as never);
        await render(<BackupSection />);
        expect(await screen.findByText('No backup saved yet')).toBeTruthy();
        await pressRun();
        expect(screen.queryByText('No backup saved yet')).toBeNull();
        expect(screen.getByText(/^Last backup /)).toBeTruthy();
    });

    it('shows the warning after a failed run', async () => {
        run.mockRejectedValue(new Error('offline'));
        await render(<BackupSection />);
        await screen.findByText('No backup saved yet');
        expect(screen.queryByTestId('backup-status-failed')).toBeNull();
        await pressRun();
        expect(screen.getByTestId('backup-status-failed')).toBeTruthy();
    });

    it('shows a changed schedule at once', async () => {
        await render(<BackupSection />);
        await screen.findByText('No backup saved yet');
        expect(screen.getByText('Schedule: Every day')).toBeTruthy();
        const changes = screen.getAllByText('Change');
        await act(async () => {
            fireEvent.press(changes[changes.length - 1]);
        });
        await act(async () => {
            fireEvent.press(screen.getByTestId('backup-cadence-weekly'));
        });
        await act(async () => {
            fireEvent.press(screen.getByTestId('backup-finish'));
        });
        expect(screen.queryByText('Schedule: Every day')).toBeNull();
        expect(screen.getByText('Schedule: Every week')).toBeTruthy();
    });
});
