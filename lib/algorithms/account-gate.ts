import type { RecheckOutcome } from '@/lib/auth-failure-breaker';

export type AccountGateVerdict = 'tabs' | 'reauth' | 'offline' | 'unreachable';

/**
 * Where a launch goes once its route is otherwise decided (FinalStart, Q1).
 * The gate awaits the account check up to a cap, so `outcome` is null only
 * when the check outlived it, which opens the app. Only DEFINITE answers gate:
 *  - the phone says it has no connection (no probe needed): offline;
 *  - the server said this session is dead: sign in again;
 *  - the check came back inconclusive AND the probe after it found the server
 *    unreachable: Mera can't be reached, unless the neutral probe found no
 *    internet either (captive portal, dead Wi-Fi), which is offline: never
 *    blame Mera for the phone's network.
 * Anything else, including a check that could not read the credential, opens
 * the app. A `dead` that lands later is the foreground gate's (ReauthOnReturn).
 */
export function accountGateVerdict(input: {
    outcome: RecheckOutcome | null;
    isConnected: boolean;
    serverReachable: boolean;
    internetReachable: boolean;
}): AccountGateVerdict {
    if (input.isConnected === false) return 'offline';
    if (input.outcome === 'dead') return 'reauth';
    if (input.outcome === 'inconclusive' && !input.serverReachable) {
        return input.internetReachable ? 'unreachable' : 'offline';
    }
    return 'tabs';
}
