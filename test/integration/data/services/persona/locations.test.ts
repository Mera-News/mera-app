// location-service `setRole` (the unlogged Places relabel) and location-persona-actions (the
// change-logged add / delete / weight surface), on the real DB.
// Replaces the mocked location-service-set-role suite.
import {
  addUserLocation,
  deleteUserLocation,
  setLocationWeightLogged,
} from '@/lib/database/services/location-persona-actions';
import { setPinnedForWeather, setRole } from '@/lib/database/services/location-service';
import { revertChange } from '@/lib/database/services/persona-change-log-service';
import {
  MIN,
  NOON,
  freezeClock,
  logRows,
  logsOf,
  quietLogger,
  resetPersonaMemory,
  rowById,
  rowsOf,
  seedPlace,
  settleWrites,
} from './support';

let logs: ReturnType<typeof quietLogger>;
beforeEach(() => {
  logs = quietLogger();
  resetPersonaMemory();
});
afterEach(async () => {
  await settleWrites();
  logs.restore();
});

const places = async () =>
  (await rowsOf('locations')).map((l) => ({ id: l.id as string, city: l.city, cc: l.countryCode, role: l.role, w: l.weight, pin: l.pinnedForWeather }));

describe('setRole', () => {
  it('relabels in place when the new role has no twin, and logs nothing', async () => {
    freezeClock(NOON);
    const home = await seedPlace('NL', 'Amsterdam', 'home');
    jest.setSystemTime(NOON + MIN);

    await setRole(home.id, 'work');

    const row = await rowById('locations', home.id);
    expect(row.role).toBe('work');
    expect(row.updatedAt.getTime()).toBe(NOON + MIN);
    expect(await logRows()).toEqual([]);
  });

  it('the same role is a no-op: no write, the row is left exactly as it was', async () => {
    freezeClock(NOON);
    const home = await seedPlace('NL', 'Amsterdam', 'home');
    jest.setSystemTime(NOON + MIN);

    await setRole(home.id, 'home');

    expect((await rowById('locations', home.id)).updatedAt.getTime()).toBe(NOON);
  });

  it('when a twin already holds the target role, this row is destroyed and the twin kept as it was', async () => {
    const home = await seedPlace('NL', 'Amsterdam', 'home', 0.9);
    const work = await seedPlace('NL', 'AMSTERDAM', 'work', 0.2); // same place, normalized

    await setRole(home.id, 'work');

    expect(await places()).toEqual([{ id: work.id, city: 'AMSTERDAM', cc: 'NL', role: 'work', w: 0.2, pin: false }]);
    await expect(rowById('locations', home.id)).rejects.toThrow();
  });

  it('the twin takes the weather pin when the relabelled row held it', async () => {
    const home = await seedPlace('NL', 'Amsterdam', 'home');
    const work = await seedPlace('NL', 'Amsterdam', 'work');
    await setPinnedForWeather(home.id);

    await setRole(home.id, 'work');

    expect(await places()).toEqual([expect.objectContaining({ id: work.id, pin: true })]);
  });

  it('a twin that already holds the pin keeps it, and the relabelled unpinned row just goes', async () => {
    const home = await seedPlace('NL', 'Amsterdam', 'home');
    const work = await seedPlace('NL', 'Amsterdam', 'work');
    await setPinnedForWeather(work.id);

    await setRole(home.id, 'work');

    expect(await places()).toEqual([expect.objectContaining({ id: work.id, pin: true })]);
  });

  it('a pin on an unrelated place is never touched', async () => {
    const home = await seedPlace('NL', 'Amsterdam', 'home');
    await seedPlace('NL', 'Amsterdam', 'work');
    const other = await seedPlace('DE', 'Berlin', 'travel');
    await setPinnedForWeather(other.id);

    await setRole(home.id, 'work');

    expect((await places()).find((p) => p.id === other.id)!.pin).toBe(true);
  });

  it('only the SAME place with the target role is a twin: another city, country or role is not', async () => {
    const home = await seedPlace('NL', 'Amsterdam', 'home');
    await seedPlace('NL', 'Rotterdam', 'work'); // other city
    await seedPlace('BE', 'Amsterdam', 'work'); // other country
    await seedPlace('NL', 'Amsterdam', 'travel'); // other role

    await setRole(home.id, 'work');

    expect(await places()).toHaveLength(4);
    expect((await rowById('locations', home.id)).role).toBe('work');
  });

  it('two country-only places (no city) are twins', async () => {
    const home = await seedPlace('NL', null, 'home');
    const work = await seedPlace('NL', null, 'work');

    await setRole(home.id, 'work');

    expect((await places()).map((p) => p.id)).toEqual([work.id]);
  });

  it('(city, country, role) stays unique after a relabel', async () => {
    const a = await seedPlace('NL', 'Amsterdam', 'home');
    await seedPlace('NL', 'Amsterdam', 'work');
    await seedPlace('NL', 'Amsterdam', 'travel');

    await setRole(a.id, 'work');

    const keys = (await places()).map((p) => `${p.city}|${p.cc}|${p.role}`);
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys.sort()).toEqual(['Amsterdam|NL|travel', 'Amsterdam|NL|work']);
  });

  it('an unknown location id rejects and changes nothing', async () => {
    await seedPlace('NL', 'Amsterdam', 'home');

    await expect(setRole('ghost', 'work')).rejects.toThrow();

    expect(await places()).toHaveLength(1);
  });
});

describe('location-persona-actions', () => {
  it('addUserLocation inserts a user-owned place and appends an audit-only add_location row', async () => {
    const { location, updated } = await addUserLocation({ city: 'Amsterdam', countryCode: 'NL', role: 'home', weight: 0.7 });

    expect(updated).toBe(false);
    expect(await rowById('locations', location.id)).toMatchObject({ city: 'Amsterdam', countryCode: 'NL', role: 'home', weight: 0.7, provenance: 'user' });
    const [row] = await logsOf('add_location');
    expect(row).toMatchObject({
      source: 'user',
      summary: 'Added location: Amsterdam, NL',
      action: { targetId: location.id, city: 'Amsterdam', countryCode: 'NL', role: 'home' },
    });
    await expect(revertChange(row.id)).rejects.toThrow("no inverse implemented for action_type 'add_location'");
  });

  it('a country-only place is labelled by its upper-cased country code', async () => {
    await addUserLocation({ countryCode: 'nl', role: 'travel' });

    expect((await logsOf('add_location'))[0].summary).toBe('Added location: NL');
  });

  it('adding the same (city, country, role) again updates in place and routes a new weight through the revertible action', async () => {
    const first = await addUserLocation({ city: 'Amsterdam', countryCode: 'NL', role: 'home', weight: 0.4 });

    const second = await addUserLocation({ city: ' amsterdam', countryCode: 'NL', role: 'home', weight: 0.9, region: 'Noord-Holland' });

    expect(second.updated).toBe(true);
    expect(second.location.id).toBe(first.location.id);
    expect(await places()).toHaveLength(1);
    expect(await rowById('locations', first.location.id)).toMatchObject({ weight: 0.9, region: 'Noord-Holland' });
    expect(await logsOf('add_location')).toHaveLength(1);
    const [weightRow] = await logsOf('set_location_weight');
    expect(weightRow).toMatchObject({ source: 'slider', action: { targetId: first.location.id, before: 0.4, after: 0.9 } });
    await revertChange(weightRow.id);
    expect((await rowById('locations', first.location.id)).weight).toBe(0.4);
  });

  it('re-adding with the same weight, or none, logs no weight change', async () => {
    await addUserLocation({ city: 'Amsterdam', countryCode: 'NL', role: 'home', weight: 0.4 });

    await addUserLocation({ city: 'Amsterdam', countryCode: 'NL', role: 'home', weight: 0.4 });
    await addUserLocation({ city: 'Amsterdam', countryCode: 'NL', role: 'home' });

    expect(await logsOf('set_location_weight')).toEqual([]);
    expect((await places())[0].w).toBe(0.4);
  });

  it('deleteUserLocation removes the place for good and appends an audit-only delete_location row', async () => {
    const home = await seedPlace('NL', 'Amsterdam', 'home');

    await deleteUserLocation({ id: home.id, city: 'Amsterdam', countryCode: 'NL', role: 'home' });

    expect(await places()).toEqual([]);
    const [row] = await logsOf('delete_location');
    expect(row).toMatchObject({
      source: 'user',
      summary: 'Removed location: Amsterdam, NL',
      action: { targetId: home.id, city: 'Amsterdam', countryCode: 'NL', role: 'home' },
    });
    await expect(revertChange(row.id)).rejects.toThrow("no inverse implemented for action_type 'delete_location'");
  });

  it('setLocationWeightLogged changes the weight through the invertible action, clamped to [0, 1]', async () => {
    const home = await seedPlace('NL', 'Amsterdam', 'home', 0.4);

    await setLocationWeightLogged(home.id, 3);

    expect((await rowById('locations', home.id)).weight).toBe(1);
    const [row] = await logsOf('set_location_weight');
    expect(row).toMatchObject({ source: 'slider', action: { targetId: home.id, before: 0.4, after: 1 } });
    await expect(revertChange(row.id)).resolves.toBe(true);
    expect((await rowById('locations', home.id)).weight).toBe(0.4);
  });
});
