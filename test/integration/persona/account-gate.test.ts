// The launch account verdict: which screen a launch lands on once the parallel session check has
// (or has not) answered. Pure, so it runs with no mocks; the same verdict, through the real
// breaker and the real gate, is exercised in launch-gate.test.ts.
import { accountGateVerdict } from '@/components/custom/auth/account-gate';

const base = { outcome: null, isConnected: true, serverReachable: true } as const;

describe('accountGateVerdict', () => {
    it('opens the app while the check is still running', () => {
        expect(accountGateVerdict(base)).toBe('tabs');
    });
    it('opens the app on alive and on a check that could not read the credential', () => {
        expect(accountGateVerdict({ ...base, outcome: 'alive' })).toBe('tabs');
        expect(accountGateVerdict({ ...base, outcome: 'no-credential' })).toBe('tabs');
    });
    it('sends a dead session to sign in', () => {
        expect(accountGateVerdict({ ...base, outcome: 'dead' })).toBe('reauth');
    });
    it('gates offline only on a definite no-connection', () => {
        expect(accountGateVerdict({ ...base, isConnected: false })).toBe('offline');
        expect(accountGateVerdict({ ...base, isConnected: false, outcome: 'dead' })).toBe('offline');
    });
    it('gates unreachable only when inconclusive AND already marked unreachable', () => {
        expect(accountGateVerdict({ ...base, outcome: 'inconclusive' })).toBe('tabs');
        expect(accountGateVerdict({ ...base, outcome: 'inconclusive', serverReachable: false })).toBe('unreachable');
        expect(accountGateVerdict({ ...base, serverReachable: false })).toBe('tabs');
    });
});
