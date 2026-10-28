// The recurring geo sweep: a deterministic first pass that writes `locations`, and names-only model
// calls that decide each due fact's PLACE (and, when the fact names the place itself, a location).
// Real in-memory DB, real location, fact and change-log services, the account call through MSW, the
// model through the gateway mock (real E2EE).
//
// The no-churn contract is first-class here: a fact is sent only when its place is due, a user's place
// is never sent, and two runs over an unchanged persona send and write nothing.
import { addFact, getFacts, markFactPlacesWrong, setFactPlaces } from '@/lib/database/services/fact-service';
import { GEO_SWEEP_COOLDOWN_MS, runGeoDerivationSweep } from '@/lib/database/services/geo-derivation-service';
import * as locationService from '@/lib/database/services/location-service';
import { getRecent } from '@/lib/database/services/persona-change-log-service';
import { getSetting, setSetting } from '@/lib/database/services/setting-service';
import * as topicReplacement from '@/lib/database/services/topic-replacement-service';
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
const PENSION = 'Pensioner';
const CLIMATE = 'Follows climate science';
const LONDON = 'Daughter studies in London';
const LAST_RUN = 'geo_derivation_last_run_at';
const FINGERPRINT = 'geo_derivation_fact_fingerprint';

let logs: ReturnType<typeof quietLogger>;

type Named = { level: string; country?: string; region?: string; city?: string; bloc?: string; role?: string };
/** A model that answers by statement: every `[id] statement` line containing a key gets that answer. */
const placesModel = (answers: Record<string, Named>) => (call: GatewayCall) => {
  const rows = userMessage(call)
    .split('\n')
    .flatMap((line) => {
      const m = /^\[([^\]]+)\] (.*)$/.exec(line);
      const key = m && Object.keys(answers).find((k) => m[2].includes(k));
      return m && key ? [{ id: m[1], ...answers[key] }] : [];
    });
  return JSON.stringify({ facts: rows });
};
const ANSWERS: Record<string, Named> = {
  Amsterdam: { level: 'city', country: 'Netherlands', city: 'Amsterdam', role: 'home' },
  Bangalore: { level: 'city', country: 'India', region: 'Karnataka', city: 'Bangalore', role: 'work' },
  Pensioner: { level: 'country', country: 'Netherlands' },
  climate: { level: 'anywhere' },
  London: { level: 'city', country: 'United Kingdom', city: 'London', role: 'family' },
};

beforeEach(async () => {
  logs = quietLogger();
  resetCloudPersonaMemory();
  await signInFixtureAccount();
  useFakeClock(T0);
  server.use(...mockGateway(() => '{"facts":[]}'));
});
afterEach(() => {
  logs.restore();
  jest.restoreAllMocks();
});

const sweep = (opts: Parameters<typeof runGeoDerivationSweep>[0] = { now: T0 }) => advanceUntilDone(runGeoDerivationSweep(opts));
const facts = async (...statements: string[]) => Promise.all(statements.map((s) => addFact(s)));
const locations = async () =>
  (await locationService.getAll()).map((l) => ({
    countryCode: l.countryCode,
    city: l.city,
    role: l.role,
    weight: l.weight,
    provenance: l.provenance,
  }));
const meta = async (id: string) => ((await getFacts()).find((f) => f.id === id)?.metadata ?? {}) as Record<string, unknown>;
const placesOf = async (id: string) => (await meta(id)).places;
const sentLines = (calls = gatewayCalls()) => calls.flatMap((c) => userMessage(c).split('\n').filter((l) => l.startsWith('[')));

describe('the deterministic pass and the location write', () => {
  it('adds a derived country with provenance llm and a change-log row naming the source fact', async () => {
    const [fact] = await facts(AMSTERDAM);

    const res = await sweep();

    expect(res).toMatchObject({ ran: true, added: 1, reweighted: 0 });
    expect(await locations()).toEqual([{ countryCode: 'NL', city: 'Amsterdam', role: 'home', weight: 1, provenance: 'llm' }]);
    const [location] = await locationService.getAll();
    expect(location.sourceFactId).toBe(fact.id);
    const log = (await getRecent()).filter((r) => r.actionType === 'add_location');
    expect(log).toHaveLength(1);
    expect(log[0]).toMatchObject({ source: 'llm', summary: 'Detected location: Amsterdam, NL' });
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

    expect(await sweep()).toMatchObject({ ran: true, added: 0, reweighted: 0 });
    expect(await locations()).toEqual([{ countryCode: 'NL', city: null, role: 'interest', weight: 0.2, provenance: 'user' }]);
  });

  it('reweights a derived row whose role strengthened, with no change-log row', async () => {
    await locationService.upsertLocation({ countryCode: 'NL', city: null, role: 'interest', weight: 0.4, provenance: 'migration' });
    await facts(AMSTERDAM);

    expect(await sweep()).toMatchObject({ ran: true, added: 0, reweighted: 1 });
    expect(await locations()).toEqual([{ countryCode: 'NL', city: null, role: 'interest', weight: 1, provenance: 'migration' }]);
    expect((await getRecent()).filter((r) => r.actionType === 'add_location')).toEqual([]);
  });

  it('one failing write does not abort the rest: the other country lands and both guards are stamped', async () => {
    await facts(AMSTERDAM, 'Follows Brazilian football');
    server.use(mockGql('AllCountries', { allCountries: ['NLD', 'BRA'] }));
    const spy = jest.spyOn(locationService, 'upsertLocation').mockRejectedValueOnce(new Error('db locked'));

    const res = await sweep();
    spy.mockRestore();

    expect(res).toMatchObject({ ran: true, added: 1, reweighted: 0 });
    expect(await locations()).toHaveLength(1);
    expect(logs.captureException.mock.calls[0][1]).toMatchObject({
      tags: { service: 'geo-derivation-service', method: 'executeSweep.apply.add' },
    });
    expect(await getSetting(LAST_RUN)).toBe(String(T0));
  });
});

describe('fact places: names in, codes stored', () => {
  it('places every fact, logs each change as llm, keeps first-fill topics, and adds a location only for a named place', async () => {
    const [pension, climate, london] = await facts(PENSION, CLIMATE, LONDON);
    server.use(mockGql('AllCountries', { allCountries: ['GBR', 'NLD'] }));
    server.use(...mockGateway(placesModel(ANSWERS)));
    const regen = jest.spyOn(topicReplacement, 'regenerateTopicsForFact');

    const res = await sweep();

    expect(res).toMatchObject({ ran: true, placed: 3, regenerated: 0, added: 1 });
    const calls = gatewayCalls();
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ route: 'batch', model: SMALL_MODEL, stream: false });
    expect(systemMessage(calls[0])).toContain('never as a code');
    expect(userMessage(calls[0])).not.toMatch(/\b(GB|NL|IN)\b/);
    expect(await placesOf(pension.id)).toEqual(['NL']);
    expect(await placesOf(climate.id)).toEqual(['GLOBAL']);
    expect(await placesOf(london.id)).toEqual(['GB||London']);
    expect(await meta(pension.id)).toMatchObject({ places_by: 'sweep', places_topics_for: ['NL'] });
    const rows = (await getRecent()).filter((r) => r.actionType === 'set_fact_places');
    expect(rows).toHaveLength(3);
    expect(rows.every((r) => r.source === 'llm')).toBe(true);
    expect(await locations()).toEqual([{ countryCode: 'GB', city: 'London', role: 'family', weight: 0.7, provenance: 'llm' }]);
    expect(regen).not.toHaveBeenCalled();
  });

  it('writes a place the server has no feeds for, but no location for it', async () => {
    const [bangalore] = await facts(BANGALORE);
    server.use(mockGql('AllCountries', { allCountries: ['NLD'] }));
    server.use(...mockGateway(placesModel(ANSWERS)));

    await sweep();

    expect(await placesOf(bangalore.id)).toEqual(['IN|Karnataka|Bangalore']);
    expect(await locations()).toEqual([]);
  });

  it('NO CHURN: a second run over an unchanged persona sends nothing and writes nothing', async () => {
    await facts(PENSION, CLIMATE, 'Collects stamps');
    server.use(...mockGateway(placesModel(ANSWERS))); // stamps gets no answer
    await sweep({ now: T0 });
    const calls = gatewayCalls().length;
    const logRows = (await getRecent()).length;

    const again = await sweep({ now: T0 + 2 * DAY });

    expect(again).toMatchObject({ ran: false, reason: 'unchanged' });
    expect(gatewayCalls()).toHaveLength(calls);
    expect(await getRecent()).toHaveLength(logRows);
  });

  it('re-sends only the edited fact', async () => {
    const [pension] = await facts(PENSION, CLIMATE);
    server.use(...mockGateway(placesModel(ANSWERS)));
    await sweep({ now: T0 });
    const before = gatewayCalls().length;

    const [added] = await facts('Follows Dutch politics');
    await sweep({ now: T0 + 2 * DAY });

    const lines = sentLines(gatewayCalls().slice(before));
    expect(lines).toEqual([`[${added.id}] Follows Dutch politics`]);
    expect(lines.some((l) => l.includes(pension.id))).toBe(false);
  });

  it('never sends or overwrites a place the reader set', async () => {
    const [mine] = await facts(PENSION);
    await advanceUntilDone(setFactPlaces(mine.id, ['IN'], 'user', { regenerate: false }));
    server.use(...mockGateway(placesModel(ANSWERS)));

    await sweep();

    expect(sentLines()).toEqual([]);
    expect(await placesOf(mine.id)).toEqual(['IN']);
  });

  it('a wrong-place mark re-sends the fact naming the rejected place; a new answer replaces it', async () => {
    const [pension] = await facts(PENSION);
    server.use(...mockGateway(placesModel(ANSWERS)));
    await sweep({ now: T0 });
    await markFactPlacesWrong(pension.id);
    server.use(...mockGateway(placesModel({ Pensioner: { level: 'country', country: 'India' } })));

    await sweep({ now: T0 + 2 * DAY });

    expect(sentLines(gatewayCalls().slice(1))).toEqual([
      `[${pension.id}] ${PENSION} (the reader said this place is wrong: Netherlands)`,
    ]);
    expect(await placesOf(pension.id)).toEqual(['IN']);
    expect((await meta(pension.id)).places_wrong).toBeUndefined();
  });

  it('a repeated rejected answer clears the place (unknown), so the location rule leaves the fact alone', async () => {
    const [pension] = await facts(PENSION);
    server.use(...mockGateway(placesModel(ANSWERS)));
    await sweep({ now: T0 });
    await markFactPlacesWrong(pension.id);

    await sweep({ now: T0 + 2 * DAY });

    expect(await placesOf(pension.id)).toEqual([]);
    expect((await meta(pension.id)).places_wrong).toBeUndefined();
  });

  it('sends 10 facts per call and at most 40 per sweep; the rest go next sweep', async () => {
    await facts(...Array.from({ length: 45 }, (_, i) => `Collects stamps number ${i}`));

    await sweep({ now: T0 });
    expect(gatewayCalls()).toHaveLength(4);
    expect(sentLines()).toHaveLength(40);

    await sweep({ now: T0 + 2 * DAY });
    expect(sentLines(gatewayCalls().slice(4))).toHaveLength(5);
  });

  it('a failed call writes no place and stamps nothing, so the facts are sent again', async () => {
    const [pension] = await facts(PENSION);
    server.use(...mockGateway(() => ({ status: 400, body: { error: 'refused' } })));

    await sweep({ now: T0 });

    expect(await meta(pension.id)).toEqual({});
    expect(await getSetting(LAST_RUN)).toBeNull();
    server.use(...mockGateway(placesModel(ANSWERS)));
    await sweep({ now: T0 + 1000 });
    expect(await placesOf(pension.id)).toEqual(['NL']);
  });

  it('a reply that is not a place list writes no place but settles the facts', async () => {
    const [pension] = await facts(PENSION);
    server.use(...mockGateway(() => 'Somewhere in India, probably.'));

    await sweep({ now: T0 });

    expect(await placesOf(pension.id)).toBeUndefined();
    expect(typeof (await meta(pension.id)).places_source).toBe('string');
    expect(await sweep({ now: T0 + 2 * DAY })).toMatchObject({ ran: false, reason: 'unchanged' });
  });
});

describe('topic regeneration for moved places', () => {
  it('regenerates facts whose place moved, at most 3 per sweep', async () => {
    const moved = await facts(...Array.from({ length: 4 }, (_, i) => `Pensioner number ${i}`));
    server.use(...mockGateway(placesModel(ANSWERS)));
    await sweep({ now: T0 });
    for (const f of moved) await markFactPlacesWrong(f.id);
    server.use(...mockGateway(placesModel({ Pensioner: { level: 'country', country: 'India' } })));
    const regen = jest
      .spyOn(topicReplacement, 'regenerateTopicsForFact')
      .mockResolvedValue({ ok: true, minted: 1, retired: 1, floorHeld: false });

    expect(await sweep({ now: T0 + 2 * DAY })).toMatchObject({ placed: 4, regenerated: 3 });
    expect(regen).toHaveBeenCalledTimes(3);
  });
});

describe('guards', () => {
  it('skips inside the 24h cooldown (no model, no write, no stamp), and runs once it has elapsed', async () => {
    await facts(AMSTERDAM);
    await setSetting(LAST_RUN, String(T0 - 1000));

    expect(await sweep({ now: T0 })).toMatchObject({ ran: false, reason: 'cooldown' });
    expect(await locations()).toEqual([]);
    expect(await getSetting(LAST_RUN)).toBe(String(T0 - 1000));

    await setSetting(LAST_RUN, String(T0 - GEO_SWEEP_COOLDOWN_MS - 1));
    expect(await sweep({ now: T0 })).toMatchObject({ ran: true, added: 1 });
  });

  it('skips with no facts', async () => {
    expect(await sweep()).toMatchObject({ ran: false, reason: 'no_facts' });
    expect(await getSetting(LAST_RUN)).toBeNull();
  });

  it('`force` bypasses the cooldown but not the no-churn check; a changed fact set runs again', async () => {
    await facts(AMSTERDAM, BANGALORE);
    expect((await sweep({ now: T0 })).ran).toBe(true);
    const callsAfterFirst = gatewayCalls().length;

    expect(await sweep({ now: T0 + 10, force: true })).toMatchObject({ ran: false, reason: 'unchanged' });
    expect(gatewayCalls()).toHaveLength(callsAfterFirst);

    await facts('Follows Brazilian football');
    expect((await sweep({ now: T0 + 20, force: true })).ran).toBe(true);
    expect(await getSetting(LAST_RUN)).toBe(String(T0 + 20));
  });

  it('serialises concurrent callers onto ONE run', async () => {
    await facts(AMSTERDAM, BANGALORE);

    const [a, b] = await advanceUntilDone(
      Promise.all([runGeoDerivationSweep({ now: T0 }), runGeoDerivationSweep({ now: T0, force: true })]),
    );

    expect(a).toBe(b);
    expect(gatewayCalls()).toHaveLength(1);
  });

  it('falls back to the full ISO set for locations when the allowed-country call fails', async () => {
    await facts(BANGALORE);
    server.use(mockGqlError('AllCountries', 'INTERNAL_SERVER_ERROR', { httpStatus: 500 }));
    server.use(...mockGateway(placesModel(ANSWERS)));

    expect(await sweep()).toMatchObject({ ran: true, added: 1 });
    expect(await locations()).toEqual([{ countryCode: 'IN', city: 'Bangalore', role: 'work', weight: 0.8, provenance: 'llm' }]);
  });
});

describe('on-device mode', () => {
  it('never sends a fact to the gateway and writes no place, yet still applies what the first pass places', async () => {
    const [amsterdam] = await facts(AMSTERDAM, 'My sister just started at a lab there');
    await setMode('on-device');

    const res = await sweep();

    expect(res).toMatchObject({ ran: true, added: 1, placed: 0 });
    expect(gatewayCalls()).toHaveLength(0);
    expect(await placesOf(amsterdam.id)).toBeUndefined();
  });

  it('sends nothing when only the persisted row says on-device: the cloud entry point refuses', async () => {
    await facts(AMSTERDAM, BANGALORE);
    await setSetting('mera_processing_mode', 'ON_DEVICE'); // the store still holds its cloud default

    expect(await sweep()).toMatchObject({ ran: true, added: 1 });
    expect(gatewayCalls()).toHaveLength(0);
  });
});

// DA31: both guards are stamped only after the model ran, so what the first pass could not place is
// retried by the next sweep (an on-device or refused sweep stamps neither).
describe('DA31: a derivation that could not ask the model is retried later', () => {
  it('DA31: a refused derivation does not arm the cooldown', async () => {
    await facts(BANGALORE);
    server.use(...mockGateway(() => ({ status: 400, body: { error: 'refused' } })));
    await sweep({ now: T0 });
    server.use(...mockGateway(placesModel(ANSWERS)));

    expect(await sweep({ now: T0 + 2 * DAY })).toMatchObject({ ran: true, added: 1 });
  });

  it('DA31: an on-device derivation leaves the unplaced facts for the cloud', async () => {
    await facts(BANGALORE);
    await setMode('on-device');
    await sweep({ now: T0 });
    await setMode('cloud');
    server.use(...mockGateway(placesModel(ANSWERS)));

    expect(await sweep({ now: T0 + 2 * DAY })).toMatchObject({ ran: true, added: 1 });
  });
});
