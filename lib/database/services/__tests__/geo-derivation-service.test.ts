// geo-derivation-service unit tests — the guards (cooldown, fingerprint,
// in-flight), the degraded allowed-enum path, and the non-destructive apply.
// The pure core (geo-derivation) runs for real so the wiring is exercised
// end-to-end; every DB / network surface is mocked.

const mockKv = new Map<string, string>();

jest.mock('@/lib/logger', () => ({
  __esModule: true,
  default: { captureException: jest.fn(() => 'evt'), warn: jest.fn(), debug: jest.fn() },
}));

jest.mock('../setting-service', () => ({
  getSetting: jest.fn(async (k: string) => mockKv.get(k) ?? null),
  setSetting: jest.fn(async (k: string, v: string) => {
    mockKv.set(k, v);
  }),
}));

jest.mock('../fact-service', () => ({
  getFacts: jest.fn(async () => []),
}));

jest.mock('../location-service', () => ({
  getAll: jest.fn(async () => []),
  upsertLocation: jest.fn(async () => ({ id: 'loc-1' })),
  setWeight: jest.fn(async () => {}),
}));

jest.mock('../persona-change-log-service', () => ({
  append: jest.fn(async () => ({ id: 'cl-1' })),
}));

jest.mock('@/lib/account-service', () => ({
  AccountService: { getAllCountries: jest.fn(async () => ['NLD', 'IND', 'BRA', 'USA']) },
}));

jest.mock('@/lib/llm/cloudComplete', () => ({
  cloudComplete: jest.fn(async () => '{"locations":[]}'),
}));

// Tier 2 ships raw fact statements to the gateway, so it is gated on the user's
// processing mode. Mutable so a test can flip the device to on-device.
const mockProcessingMode = { current: 'CLOUD' };
jest.mock('@/lib/stores/mera-protocol-store', () => ({
  useMeraProtocolStore: {
    getState: () => ({ processingMode: mockProcessingMode.current }),
  },
}));

import {
  runGeoDerivationSweep,
  GEO_SWEEP_COOLDOWN_MS,
} from '../geo-derivation-service';
import * as factService from '../fact-service';
import * as locationService from '../location-service';
import * as changeLog from '../persona-change-log-service';
import { AccountService } from '@/lib/account-service';
import { cloudComplete } from '@/lib/llm/cloudComplete';

const NOW = 1_700_000_000_000;

function seedFacts(statements: string[]) {
  (factService.getFacts as jest.Mock).mockResolvedValue(
    statements.map((statement, i) => ({ id: `f${i}`, statement })),
  );
}

beforeEach(() => {
  mockKv.clear();
  jest.clearAllMocks();
  (factService.getFacts as jest.Mock).mockResolvedValue([]);
  (locationService.getAll as jest.Mock).mockResolvedValue([]);
  (locationService.upsertLocation as jest.Mock).mockResolvedValue({ id: 'loc-1' });
  (AccountService.getAllCountries as jest.Mock).mockResolvedValue(['NLD', 'IND', 'BRA', 'USA']);
  (cloudComplete as jest.Mock).mockResolvedValue('{"locations":[]}');
  mockProcessingMode.current = 'CLOUD';
});

describe('runGeoDerivationSweep — processing-mode gate', () => {
  it('never calls the gateway when the user chose on-device processing', async () => {
    mockProcessingMode.current = 'ON_DEVICE';
    // A statement tier 1 cannot resolve — normally this would go to tier 2.
    seedFacts(['My sister just started at a lab there']);

    const res = await runGeoDerivationSweep({ now: NOW });

    expect(cloudComplete).not.toHaveBeenCalled();
    expect(res.ran).toBe(true);
    expect(res.added).toBe(0);
  });

  it('still applies tier-1 results on-device (the sweep is not disabled, only tier 2)', async () => {
    mockProcessingMode.current = 'ON_DEVICE';
    seedFacts(['Lives in Amsterdam, Netherlands']);

    const res = await runGeoDerivationSweep({ now: NOW });

    expect(cloudComplete).not.toHaveBeenCalled();
    expect(res.added).toBe(1);
    expect(locationService.upsertLocation).toHaveBeenCalledWith(
      expect.objectContaining({ countryCode: 'NL', provenance: 'llm' }),
    );
  });
});

describe('runGeoDerivationSweep — guards', () => {
  it('skips on cooldown without loading facts', async () => {
    mockKv.set('geo_derivation_last_run_at', String(NOW - 1000));
    seedFacts(['Lives in Amsterdam, Netherlands']);

    const res = await runGeoDerivationSweep({ now: NOW });

    expect(res).toEqual({ ran: false, reason: 'cooldown', added: 0, reweighted: 0 });
    expect(factService.getFacts).not.toHaveBeenCalled();
    expect(locationService.upsertLocation).not.toHaveBeenCalled();
  });

  it('runs once the cooldown has elapsed', async () => {
    mockKv.set('geo_derivation_last_run_at', String(NOW - GEO_SWEEP_COOLDOWN_MS - 1));
    seedFacts(['Lives in Amsterdam, Netherlands']);

    const res = await runGeoDerivationSweep({ now: NOW });

    expect(res.ran).toBe(true);
    expect(res.added).toBe(1);
  });

  it('skips when there are no facts', async () => {
    const res = await runGeoDerivationSweep({ now: NOW });
    expect(res).toEqual({ ran: false, reason: 'no_facts', added: 0, reweighted: 0 });
  });

  it('force bypasses the cooldown but NOT the fact fingerprint', async () => {
    seedFacts(['Lives in Amsterdam, Netherlands']);

    const first = await runGeoDerivationSweep({ now: NOW });
    expect(first.ran).toBe(true);
    expect(first.added).toBe(1);

    // Same facts, immediately again, forced: cooldown is bypassed, the
    // fingerprint is not — so no second LLM call and no second write.
    (locationService.upsertLocation as jest.Mock).mockClear();
    const second = await runGeoDerivationSweep({ now: NOW + 10, force: true });

    expect(second).toEqual({ ran: false, reason: 'unchanged', added: 0, reweighted: 0 });
    expect(locationService.upsertLocation).not.toHaveBeenCalled();
  });

  it('runs again once the fact set changes', async () => {
    seedFacts(['Lives in Amsterdam, Netherlands']);
    await runGeoDerivationSweep({ now: NOW });

    seedFacts(['Lives in Amsterdam, Netherlands', 'Follows Brazilian football']);
    const res = await runGeoDerivationSweep({ now: NOW + 10, force: true });
    expect(res.ran).toBe(true);
  });

  it('serializes concurrent callers onto ONE run (in-flight guard)', async () => {
    seedFacts(['Lives in Amsterdam, Netherlands']);

    const [a, b] = await Promise.all([
      runGeoDerivationSweep({ now: NOW }),
      runGeoDerivationSweep({ now: NOW, force: true }),
    ]);

    expect(a).toBe(b);
    expect(factService.getFacts).toHaveBeenCalledTimes(1);
    expect(locationService.upsertLocation).toHaveBeenCalledTimes(1);
  });
});

describe('runGeoDerivationSweep — writes', () => {
  it('adds a derived country with provenance llm and a change-log row', async () => {
    seedFacts(['Lives in Amsterdam, Netherlands']);

    const res = await runGeoDerivationSweep({ now: NOW });

    expect(res).toMatchObject({ ran: true, added: 1, reweighted: 0 });
    expect(locationService.upsertLocation).toHaveBeenCalledWith(
      expect.objectContaining({
        countryCode: 'NL',
        city: 'Amsterdam',
        role: 'home',
        weight: 1,
        provenance: 'llm',
        sourceFactId: 'f0',
      }),
    );
    expect(changeLog.append).toHaveBeenCalledWith(
      expect.objectContaining({ actionType: 'add_location', source: 'llm' }),
    );
    expect(mockKv.get('geo_derivation_last_run_at')).toBe(String(NOW));
    expect(mockKv.get('geo_derivation_fact_fingerprint')).toBeTruthy();
  });

  it('never touches a hand-added provenance:user row', async () => {
    (locationService.getAll as jest.Mock).mockResolvedValue([
      { id: 'l1', countryCode: 'NL', city: null, role: 'interest', weight: 0.2, provenance: 'user' },
    ]);
    seedFacts(['Lives in Amsterdam, Netherlands']);

    const res = await runGeoDerivationSweep({ now: NOW });

    expect(res).toMatchObject({ ran: true, added: 0, reweighted: 0 });
    expect(locationService.upsertLocation).not.toHaveBeenCalled();
    expect(locationService.setWeight).not.toHaveBeenCalled();
  });

  it('reweights a derived row whose role strengthened', async () => {
    (locationService.getAll as jest.Mock).mockResolvedValue([
      { id: 'l1', countryCode: 'NL', city: null, role: 'interest', weight: 0.4, provenance: 'migration' },
    ]);
    seedFacts(['Lives in Amsterdam, Netherlands']);

    const res = await runGeoDerivationSweep({ now: NOW });

    expect(res).toMatchObject({ ran: true, added: 0, reweighted: 1 });
    expect(locationService.setWeight).toHaveBeenCalledWith('l1', 1);
  });

  it('applies tier-2 rows and drops codes outside the server enum', async () => {
    (AccountService.getAllCountries as jest.Mock).mockResolvedValue(['IND']);
    (cloudComplete as jest.Mock).mockResolvedValue(
      '{"locations":[{"id":"f0","country":"IN","city":"Bangalore","role":"home"},' +
        '{"id":"f1","country":"FR","role":"interest"}]}',
    );
    seedFacts(['Works at a startup in Bangalore', 'Reads about wine']);

    const res = await runGeoDerivationSweep({ now: NOW });

    expect(res).toMatchObject({ ran: true, added: 1 });
    expect(locationService.upsertLocation).toHaveBeenCalledTimes(1);
    expect(locationService.upsertLocation).toHaveBeenCalledWith(
      expect.objectContaining({ countryCode: 'IN', city: 'Bangalore' }),
    );
  });
});

describe('runGeoDerivationSweep — degraded paths', () => {
  it('degrades to the permissive full ISO set when getAllCountries throws', async () => {
    (AccountService.getAllCountries as jest.Mock).mockRejectedValue(new Error('offline'));
    (cloudComplete as jest.Mock).mockResolvedValue(
      '{"locations":[{"id":"f0","country":"IN","city":"Bangalore","role":"home"}]}',
    );
    seedFacts(['Works at a startup in Bangalore']);

    const res = await runGeoDerivationSweep({ now: NOW });

    expect(res).toMatchObject({ ran: true, added: 1 });
  });

  it('degrades to tier-1-only when the LLM gateway fails', async () => {
    (cloudComplete as jest.Mock).mockRejectedValue(new Error('502'));
    seedFacts(['Lives in Amsterdam, Netherlands', 'Works at a startup in Bangalore']);

    const res = await runGeoDerivationSweep({ now: NOW });

    expect(res).toMatchObject({ ran: true, added: 1 });
    expect(locationService.upsertLocation).toHaveBeenCalledWith(
      expect.objectContaining({ countryCode: 'NL' }),
    );
  });

  it('does not abort the remaining ops when one write throws', async () => {
    (locationService.upsertLocation as jest.Mock)
      .mockRejectedValueOnce(new Error('db locked'))
      .mockResolvedValue({ id: 'loc-2' });
    seedFacts(['Lives in Amsterdam, Netherlands', 'Follows Brazilian football']);

    const res = await runGeoDerivationSweep({ now: NOW });

    expect(res.ran).toBe(true);
    expect(res.added).toBe(1);
    expect(locationService.upsertLocation).toHaveBeenCalledTimes(2);
  });
});
