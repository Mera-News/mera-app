import type { RecheckOutcome } from '@/lib/auth-failure-breaker';

export type AccountGateVerdict = 'tabs' | 'reauth' | 'offline' | 'unreachable';

/**
 * Where a launch goes once its route is otherwise decided (FinalStart, Q1).
 * The account check runs in parallel and is never awaited, so `outcome` is
 * null when it has not settled yet: that is the normal fast path and opens the
 * app. Only DEFINITE answers gate:
 *  - the phone says it has no connection (no probe needed): offline;
 *  - the server said this session is dead: sign in again;
 *  - the check came back inconclusive AND the server is already marked
 *    unreachable: Mera can't be reached.
 * Anything else, including a check that could not read the credential, opens
 * the app. A `dead` that lands later is the foreground gate's (ReauthOnReturn).
 */
export function accountGateVerdict(input: {
    outcome: RecheckOutcome | null;
    isConnected: boolean;
    serverReachable: boolean;
}): AccountGateVerdict {
    if (input.isConnected === false) return 'offline';
    if (input.outcome === 'dead') return 'reauth';
    if (input.outcome === 'inconclusive' && !input.serverReachable) return 'unreachable';
    return 'tabs';
}
