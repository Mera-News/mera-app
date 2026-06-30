import Constants from 'expo-constants';

export function getGitCommit(): string {
    return (Constants.expoConfig?.extra?.gitCommit as string | undefined) ?? 'unknown';
}

export function getAppVersion(): string {
    return Constants.expoConfig?.version ?? '';
}

export function getAppVersionLabel(): string {
    const version = getAppVersion();
    const commit = getGitCommit();
    return version ? `v${version} · ${commit}` : commit;
}

function parseVersion(version: string): number[] | null {
    if (!version) return null;
    const segments = version.trim().split('.');
    const numbers: number[] = [];
    for (const segment of segments) {
        const value = Number(segment);
        if (!Number.isInteger(value) || value < 0) return null;
        numbers.push(value);
    }
    return numbers.length ? numbers : null;
}

/**
 * Strict comparison of dot-separated numeric versions. Returns true when
 * `current` is strictly older than `target` (e.g. "1.1.10" < "1.2.0"). Missing
 * trailing segments count as 0, so "1.2" === "1.2.0". If either version is empty
 * or non-numeric we return false — an unparseable version must never trigger a
 * force-update.
 */
export function isVersionOlder(current: string, target: string): boolean {
    const a = parseVersion(current);
    const b = parseVersion(target);
    if (!a || !b) return false;

    const length = Math.max(a.length, b.length);
    for (let i = 0; i < length; i++) {
        const x = a[i] ?? 0;
        const y = b[i] ?? 0;
        if (x < y) return true;
        if (x > y) return false;
    }
    return false;
}
