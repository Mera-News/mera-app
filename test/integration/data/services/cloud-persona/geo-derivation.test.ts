// The recurring fact -> country sweep: a deterministic first pass over the facts, ONE batched model call
// for what it cannot place, and an additive, non-destructive write to `locations`. Real in-memory DB,
// real location and change-log services, the account call through MSW, the model through the gateway
// mock (real E2EE).
//
// Replaces geo-derivation-service.test.ts (15 `it`). Carried: on-device never calls the gateway; tier 1
// still applies on-device; skips on cooldown; runs once the cooldown has elapsed; skips with no facts;
// `force` bypasses the cooldown but NOT the fingerprint; runs again once the fact set changes; concurrent
// callers share one run; adds a derived country with provenance llm and a change-log row; never touches
// a hand-added row; reweights a derived row whose role strengthened; applies tier-2 rows and drops
// codes outside the server enum; falls back to the full ISO set when the enum call fails; degrades to
// tier 1 when the gateway fails; one failing write does not abort the rest.
// Not carried: "skips on cooldown without loading facts" asserts a call count on a mocked getFacts; here
// it is asserted as no row written, no model call and no stamp change.
// Note: the legacy suite mocked the store, so on-device was a mocked string. Here it is the real store
// (and a row-only variant that proves the cloud entry's own gate stops a request).
import { addFact } from '@/lib/database/services/fact-service';
import { GEO_SWEEP_COOLDOWN_MS, runGeoDerivationSweep } from '@/lib/database/services/geo-derivation-service';
import * as locationService from '@/lib/database/services/location-service';
import { getRecent } from '@/lib/database/services/persona-change-log-service';
import { getSetting, setSetting } from '@/lib/database/services/setting-service';
import { SMALL_MODEL } from '@/lib/llm/constants';
import {
  advanceUntilDone,
  gatewayCalls,
  mockGateway,
  mockGql,
  mockGqlError,
  server,
  signInFixtureAccount,
  useFakeClock,
} from '@/test/helpers';
import type { GatewayCall } from '@/test/helpers';

import { DAY, T0, quietLogger, resetCloudPersonaMemory, setMode, systemMessage, userMessage } from './support';

const AMSTERDAM = 'Lives in Amsterdam, Netherlands';
const BANGALORE = 'Works at a startup in Bangalore';
const WINE = 'Reads about wine';
const LAST_RUN = 'geo_derivation_last_run_at';
const FINGERPRINT = 'geo_derivation_fact_fingerprint';

let logs: ReturnType<typeof quietLogger>;

type Answer = { country: string; city?: string; role?: string };
/** A model that answers by statement: every `[id] statement` line whose statement contains a key gets that answer. */
const geoModel = (answers: Record<string, Answer>) => (call: GatewayCall) => {
  const locations = userMessage(call)
    .split('\n')
    .flatMap((line) => {
      const m = /^\[([^\]]+)\] (.*)$/.exec(line);
      const key = m && Object.keys(answers).find((k) => m[2].includes(k));
      return m && key ? [{ id: m[1], ...answers[key] }] : [];
    });
  return JSON.stringify({ locations });
};

beforeEach(async () => {
  logs = quietLogger();
  resetCloudPersonaMemory();
  await signInFixtureAccount();
  useFakeClock(T0);
  server.use(...mockGateway(() => '{"locations":[]}'));
});
afterEach(() => logs.restore());

const sweep = (opts: Parameters<typeof runGeoDerivationSweep>[0] = { now: T0 }) => advanceUntilDone(runGeoDerivationSweep(opts));
const facts = async (...statements: string[]) => Promise.all(statements.map((s) => addFact(s)));
const places = async () =>
  (await locationService.getAll()).map((l) => ({
    countryCode: l.countryCode,
    city: l.city,
    role: l.role,
    weight: l.weight,
    provenance: l.provenance,
  }));

describe('the deterministic pass and the write', () => {
  it('adds a derived country with provenance llm, no model call, and a change-log row naming the source fact', async () => {
    const [fact] = await facts(AMSTERDAM);

    const res = await sweep();

    expect(res).toEqual({ ran: true, added: 1, reweighted: 0 });
    expect(gatewayCalls()).toHaveLength(0); // "Amsterdam, Netherlands" places itself
    expect(await places()).toEqual([{ countryCode: 'NL', city: 'Amsterdam', role: 'home', weight: 1, provenance: 'llm' }]);
    const [location] = await locationService.getAll();
    expect(location.sourceFactId).toBe(fact.id);
    const log = await getRecent();
    expect(log).toHaveLength(1);
    expect(log[0]).toMatchObject({ actionType: 'add_location', source: 'llm', summary: 'Detected location: Amsterdam, NL' });
    expect(JSON.parse(log[0].actionJson)).toEqual({
      targetId: location.id,
      city: 'Amsterdam',
      countryCode: 'NL',
      role: 'home',
      sourceFactId: fact.id,
    });
    expect(await getSetting(LAST_RUN)).toBe(String(T0));
    expect(await getSetting(FINGERPRINT)).toMatch(/^1:/);
  });

  it('never touches a hand-added country, whatever the facts say', async () => {
    await locationService.upsertLocation({ countryCode: 'NL', city: null, role: 'interest', weight: 0.2, provenance: 'user' });
    await facts(AMSTERDAM);

    const res = await sweep();

    expect(res).toEqual({ ran: true, added: 0, reweighted: 0 });
    expect(await places()).toEqual([{ countryCode: 'NL', city: null, role: 'interest', weight: 0.2, provenance: 'user' }]);
    expect(await getRecent()).toEqual([]);
  });

  it('reweights a derived row whose role strengthened, with no change-log row', async () => {
    await locationService.upsertLocation({ countryCode: 'NL', city: null, role: 'interest', weight: 0.4, provenance: 'migration' });
    await facts(AMSTERDAM);

    const res = await sweep();

    expect(res).toEqual({ ran: true, added: 0, reweighted: 1 });
    expect(await places()).toEqual([{ countryCode: 'NL', city: null, role: 'interest', weight: 1, provenance: 'migration' }]);
    expect(await getRecent()).toEqual([]);
  });

  it('one failing write does not abort the rest: the other country lands and both guards are stamped', async () => {
    await facts(AMSTERDAM, 'Follows Brazilian football');
    server.use(mockGql('AllCountries', { allCountries: ['NLD', 'BRA'] }));
    const spy = jest.spyOn(locationService, 'upsertLocation').mockRejectedValueOnce(new Error('db locked'));

    const res = await sweep();
    spy.mockRestore();

    expect(res).toEqual({ ran: true, added: 1, reweighted: 0 });
    expect(await places()).toHaveLength(1);
    expect(logs.captureException).toHaveBeenCalledTimes(1);
    expect(logs.captureException.mock.calls[0][1]).toMatchObject({
      tags: { service: 'geo-derivation-service', method: 'executeSweep.apply.add' },
    });
    expect(await getSetting(LAST_RUN)).toBe(String(T0));
    expect((await getRecent()).length).toBe(1);
  });
});

describe('tier 2: one batched model call for what the first pass could not place', () => {
  it('sends only the unresolved facts, once, with the server enum, and keeps only codes the server has', async () => {
    const [, bangalore, wine] = await facts(AMSTERDAM, BANGALORE, WINE);
    server.use(mockGql('AllCountries', { allCountries: ['IND', 'NLD'] }));
    server.use(...mockGateway(geoModel({ Bangalore: { country: 'IN', city: 'Bangalore', role: 'home' }, wine: { country: 'FR', role: 'interest' } })));

    const res = await sweep();

    expect(res).toEqual({ ran: true, added: 2, reweighted: 0 }); // Amsterdam by tier 1, Bangalore by the model; France is not served
    const calls = gatewayCalls();
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ route: 'chat', model: SMALL_MODEL, stream: false });
    expect(userMessage(calls[0]).split('\n').sort()).toEqual([`[${bangalore.id}] ${BANGALORE}`, `[${wine.id}] ${WINE}`].sort());
    expect(systemMessage(calls[0])).toContain('Valid codes: IN, NL');
    expect((await places()).map((p) => p.countryCode).sort()).toEqual(['IN', 'NL']);
    expect((await places()).find((p) => p.countryCode === 'IN')).toMatchObject({ city: 'Bangalore', role: 'home', provenance: 'llm' });
  });

  it('asks the model about at most 12 facts, preferring ones that look like they name a place', async () => {
    const plain = Array.from({ length: 12 }, (_, i) => `Collects stamps number ${i}`);
    const [hinted] = await facts('Spent a summer in Kerala', ...plain);

    await sweep();

    const lines = userMessage(gatewayCalls()[0]).split('\n');
    expect(lines).toHaveLength(12);
    expect(lines).toContain(`[${hinted.id}] Spent a summer in Kerala`);
  });

  it('degrades to the permissive full ISO set when the allowed-country call fails', async () => {
    await facts(BANGALORE);
    server.use(mockGqlError('AllCountries', 'INTERNAL_SERVER_ERROR', { httpStatus: 500 }));
    server.use(...mockGateway(geoModel({ Bangalore: { country: 'IN', city: 'Bangalore', role: 'home' } })));

    const res = await sweep();

    expect(res).toMatchObject({ ran: true, added: 1 });
    expect(logs.captureException).toHaveBeenCalled(); // the enum call's own capture
    expect(await places()).toEqual([{ countryCode: 'IN', city: 'Bangalore', role: 'home', weight: 1, provenance: 'llm' }]);
  });

  it('also falls back to the full ISO set when the server lists no country at all', async () => {
    await facts(BANGALORE);
    server.use(mockGql('AllCountries', { allCountries: [] }));
    server.use(...mockGateway(geoModel({ Bangalore: { country: 'IN', city: 'Bangalore', role: 'home' } })));

    expect(await sweep()).toMatchObject({ ran: true, added: 1 });
    expect(logs.warn).toHaveBeenCalledWith(expect.stringContaining('resolved empty'));
  });

  it('degrades to tier 1 only when the gateway refuses, reporting it once', async () => {
    await facts(AMSTERDAM, BANGALORE);
    server.use(...mockGateway(() => ({ status: 400, body: { error: 'refused' } })));

    const res = await sweep();

    expect(res).toEqual({ ran: true, added: 1, reweighted: 0 });
    expect((await places()).map((p) => p.countryCode)).toEqual(['NL']);
    const gatewayCaptures = logs.captureException.mock.calls.filter(
      ([, ctx]) => (ctx as { tags?: { method?: string } })?.tags?.method === 'executeSweep.gateway',
    );
    expect(gatewayCaptures).toHaveLength(1);
  });

  it('a model reply that is not a location list adds nothing', async () => {
    await facts(BANGALORE);
    server.use(...mockGateway(() => 'Somewhere in India, probably.'));

    expect(await sweep()).toEqual({ ran: true, added: 0, reweighted: 0 });
    expect(await places()).toEqual([]);
  });
});

describe('guards', () => {
  it('skips inside the 24h cooldown (no model, no write, no stamp), and runs once it has elapsed', async () => {
    await facts(AMSTERDAM);
    await setSetting(LAST_RUN, String(T0 - 1000));

    expect(await sweep({ now: T0 })).toEqual({ ran: false, reason: 'cooldown', added: 0, reweighted: 0 });
    expect(await places()).toEqual([]);
    expect(await getSetting(LAST_RUN)).toBe(String(T0 - 1000));

    await setSetting(LAST_RUN, String(T0 - GEO_SWEEP_COOLDOWN_MS - 1));
    expect(await sweep({ now: T0 })).toMatchObject({ ran: true, added: 1 });
  });

  it('skips with no facts', async () => {
    expect(await sweep()).toEqual({ ran: false, reason: 'no_facts', added: 0, reweighted: 0 });
    expect(await getSetting(LAST_RUN)).toBeNull();
  });

  it('`force` bypasses the cooldown but NOT the fact fingerprint; a changed fact set runs again', async () => {
    await facts(AMSTERDAM, BANGALORE);
    expect((await sweep({ now: T0 })).ran).toBe(true);
    const callsAfterFirst = gatewayCalls().length;

    const again = await sweep({ now: T0 + 10, force: true });
    expect(again).toEqual({ ran: false, reason: 'unchanged', added: 0, reweighted: 0 });
    expect(gatewayCalls()).toHaveLength(callsAfterFirst); // a fact-save batch must not re-ask the model

    await facts('Follows Brazilian football');
    const changed = await sweep({ now: T0 + 20, force: true });
    expect(changed.ran).toBe(true);
    expect(await getSetting(LAST_RUN)).toBe(String(T0 + 20));
  });

  it('serialises concurrent callers onto ONE run', async () => {
    await facts(AMSTERDAM, BANGALORE);

    const [a, b] = await advanceUntilDone(
      Promise.all([runGeoDerivationSweep({ now: T0 }), runGeoDerivationSweep({ now: T0, force: true })]),
    );

    expect(a).toBe(b);
    expect(await places()).toHaveLength(1);
    expect(gatewayCalls()).toHaveLength(1);
    expect((await getRecent()).length).toBe(1);
  });
});

describe('on-device mode', () => {
  it('never sends a fact to the gateway, yet still applies what the first pass places', async () => {
    await facts(AMSTERDAM, 'My sister just started at a lab there');
    await setMode('on-device');

    const res = await sweep();

    expect(res).toEqual({ ran: true, added: 1, reweighted: 0 });
    expect(gatewayCalls()).toHaveLength(0);
    expect((await places()).map((p) => p.countryCode)).toEqual(['NL']);
  });

  it('sends nothing when only the persisted row says on-device: the cloud entry point refuses and the first pass still applies', async () => {
    await facts(AMSTERDAM, BANGALORE);
    await setSetting('mera_processing_mode', 'ON_DEVICE'); // the store still holds its cloud default

    const res = await sweep();

    expect(gatewayCalls()).toHaveLength(0);
    expect(res).toEqual({ ran: true, added: 1, reweighted: 0 });
  });
});

// DA31: both guards are stamped after tier 2 whether or not it ran, so the facts the first pass could not
// place wait for the next fact change (the fingerprint is never bypassed, even once the cooldown is over).
describe('DA31: a derivation that could not ask the model is retried later', () => {
  const answers = geoModel({ Bangalore: { country: 'IN', city: 'Bangalore', role: 'home' } });

  test.failing('DA31: a refused derivation does not arm the cooldown', async () => {
    await facts(BANGALORE);
    server.use(...mockGateway(() => ({ status: 400, body: { error: 'refused' } })));
    await sweep({ now: T0 });
    server.use(...mockGateway(answers));

    const later = await sweep({ now: T0 + 2 * DAY });

    expect(later).toMatchObject({ ran: true, added: 1 });
    expect(await places()).toEqual([{ countryCode: 'IN', city: 'Bangalore', role: 'home', weight: 1, provenance: 'llm' }]);
  });

  it('DA31 today: a refused gateway call still stamps the cooldown and the fingerprint, so the same facts are not retried', async () => {
    await facts(BANGALORE);
    server.use(...mockGateway(() => ({ status: 400, body: { error: 'refused' } })));
    await sweep({ now: T0 });
    server.use(...mockGateway(answers));

    const later = await sweep({ now: T0 + 2 * DAY });

    expect(later).toEqual({ ran: false, reason: 'unchanged', added: 0, reweighted: 0 });
    expect(await places()).toEqual([]);
  });

  test.failing('DA31: an on-device derivation leaves the unplaced facts for the cloud', async () => {
    await facts(BANGALORE);
    await setMode('on-device');
    await sweep({ now: T0 });
    await setMode('cloud');
    server.use(...mockGateway(answers));

    const later = await sweep({ now: T0 + 2 * DAY });

    expect(later).toMatchObject({ ran: true, added: 1 });
  });

  it('DA31 today: an on-device sweep stamps the fingerprint, so switching back to the cloud does not place the leftovers', async () => {
    await facts(BANGALORE);
    await setMode('on-device');
    await sweep({ now: T0 });
    await setMode('cloud');
    server.use(...mockGateway(answers));

    const later = await sweep({ now: T0 + 2 * DAY });

    expect(later.reason).toBe('unchanged');
    expect(gatewayCalls()).toHaveLength(0);
  });
});
