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
