// The request census for wakes: every request the app sends while it runs, by host, and the launch
// state a wake starts from. A wake test asserts against `hosts()` (only the pod's, plus Expo's update
// host while the owner's decision on the native update check is open).
import { appStateModule } from './app-state';
import { server } from './msw';
import { resetForegroundGateForTests } from '@/lib/startup/foreground-gate';

export type CensusEntry = { host: string; method: string; path: string; operation: string | null };

/** Records every request from now until `stop()`, with the GraphQL operation name when there is one. */
export function recordRequests(): { stop: () => Promise<CensusEntry[]>; hosts: () => string[] } {
    const seen: CensusEntry[] = [];
    const pending: Promise<unknown>[] = [];
    const listener = ({ request }: { request: Request }) => {
        const url = new URL(request.url);
        const entry: CensusEntry = { host: url.host, method: request.method, path: url.pathname, operation: null };
        seen.push(entry);
        if (url.pathname.endsWith('/graphql')) {
            pending.push(
                request
                    .clone()
                    .json()
                    .then((b: { operationName?: string }) => {
                        entry.operation = b.operationName ?? null;
                    })
                    .catch(() => undefined),
            );
        }
    };
    server.events.on('request:start', listener);
    return {
        hosts: () => [...new Set(seen.map((e) => e.host))],
        stop: async () => {
            server.events.removeListener('request:start', listener);
            await Promise.all(pending);
            return seen;
        },
    };
}

/** A launch the OS made in the background: AppState reads `background` and the foreground gate is closed. */
export function launchInBackground(): void {
    appStateModule.currentState = 'background';
    resetForegroundGateForTests();
}

/** Back to a foreground process, as every other test expects. */
export function launchInForeground(): void {
    appStateModule.currentState = 'active';
    resetForegroundGateForTests();
}
