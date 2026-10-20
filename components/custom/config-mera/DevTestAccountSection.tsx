// Observability's test-account controls. DEV BUILDS WITH A TEST-ACCOUNT TOKEN
// ONLY (renders nothing otherwise), so the copy is hardcoded English like the
// blob probe's: a developer tool, not user-facing text.
import { router } from 'expo-router';
import React, { useCallback, useEffect, useState } from 'react';

import { Pressable } from '@/components/ui/pressable';
import { Text } from '@/components/ui/text';
import { VStack } from '@/components/ui/vstack';
import {
    currentTestAccountHandle,
    hasTestAccountToken,
    listTestAccounts,
    type TestAccountSummary,
} from '@/lib/device-auth';
import { showDialog } from '@/lib/dialog';
import { useUserStore } from '@/lib/stores/user-store';

import { newThrowawayHandle, removeTestAccount, signInToTestAccount } from '../auth/useDevTestAccountLink';

const Button = ({ label, onPress, busy, testID }: { label: string; onPress: () => void; busy: boolean; testID: string }) => (
    <Pressable
        onPress={busy ? undefined : onPress}
        disabled={busy}
        className="bg-surface rounded-xl px-4 py-3 mt-1"
        testID={testID}
    >
        <Text size="sm" className={busy ? 'text-ink-3 text-center' : 'text-ink text-center'}>
            {label}
        </Text>
    </Pressable>
);

export default function DevTestAccountSection({ header }: { header: React.ReactNode }) {
    const userId = useUserStore((s) => s.userId);
    const [handle, setHandle] = useState<string | null>(null);
    const [accounts, setAccounts] = useState<TestAccountSummary[] | null>(null);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const refresh = useCallback(async () => {
        setHandle(await currentTestAccountHandle());
        setAccounts(await listTestAccounts());
    }, []);

    useEffect(() => {
        if (hasTestAccountToken()) void refresh();
    }, [refresh]);

    const switchTo = useCallback(async (target: string, reset = false) => {
        setBusy(true);
        setError(null);
        const outcome = await signInToTestAccount(target, { reset });
        setBusy(false);
        if (!outcome.ok) {
            setError(`Sign-in failed: ${outcome.why}`);
            return;
        }
        // Through the launch gate, which wipes the previous account's data.
        router.dismissAll();
        router.replace('/logged-in');
    }, []);

    const reset = useCallback(async () => {
        if (!handle) return;
        const ok = await showDialog({
            title: 'Reset test account',
            body: `Delete ${handle} and sign in to a fresh account with the same handle.`,
            confirmLabel: 'Reset',
            cancelLabel: 'Cancel',
            destructive: true,
        });
        if (ok) await switchTo(handle, true);
    }, [handle, switchTo]);

    const remove = useCallback(async () => {
        if (!handle) return;
        const ok = await showDialog({
            title: 'Delete test account',
            body: `Delete ${handle} now. If it is the signed-in account, this phone signs out.`,
            warning: "You can't undo this.",
            confirmLabel: 'Delete',
            cancelLabel: 'Cancel',
            destructive: true,
        });
        if (!ok) return;
        setBusy(true);
        const result = await removeTestAccount(handle, userId);
        if (result === 'signed-out') return;
        setBusy(false);
        if (result !== 'deleted') {
            setError(`Delete failed: ${result}`);
            return;
        }
        setError(`Deleted ${handle}. It was not the signed-in account, so this phone stays signed in.`);
        await refresh();
    }, [handle, userId, refresh]);

    if (!__DEV__ || !hasTestAccountToken()) return null;

    return (
        <>
            {header}
            <VStack space="xs">
                <Text size="xs" className="text-ink-2" testID="observability-test-account-current">
                    Handle: {handle ?? '…'} · User: {userId ?? 'none'}
                </Text>
                {error ? (
                    <Text size="xs" className="text-negative">
                        {error}
                    </Text>
                ) : null}
                {(accounts ?? [])
                    .filter((a) => a.handle !== handle)
                    .map((a) => (
                        <Button
                            key={a.handle}
                            label={`Switch to ${a.handle}`}
                            onPress={() => void switchTo(a.handle)}
                            busy={busy}
                            testID={`observability-test-account-switch-${a.handle}`}
                        />
                    ))}
                {accounts === null ? (
                    <Text size="xs" className="text-ink-3">
                        Account list unavailable
                    </Text>
                ) : null}
                <Button
                    label="New throwaway"
                    onPress={() => void switchTo(newThrowawayHandle())}
                    busy={busy}
                    testID="observability-test-account-new"
                />
                <Button label="Reset" onPress={() => void reset()} busy={busy} testID="observability-test-account-reset" />
                <Button label="Delete" onPress={() => void remove()} busy={busy} testID="observability-test-account-delete" />
            </VStack>
        </>
    );
}
