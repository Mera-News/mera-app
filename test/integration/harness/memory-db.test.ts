import { Q } from '@nozbe/watermelondb';
import database from '@/lib/database';
import { getSetting, setSetting } from '@/lib/database/services/setting-service';
import { resetDatabase, useFakeClock } from '@/test/helpers';

const settings = () => database.collections.get('settings');
const facts = () => database.collections.get('facts');

describe('in-memory WatermelonDB', () => {
  it('starts empty on every test (per-test reset)', async () => {
    expect(await settings().query().fetchCount()).toBe(0);
    expect(await facts().query().fetchCount()).toBe(0);
  });

  it('creates, queries and observes rows on real tables, then resets in place', async () => {
    await setSetting('harness.key', 'v1');
    expect(await getSetting('harness.key')).toBe('v1');

    const fact = await database.write(() =>
      facts().create((f: any) => {
        f.statement = 'the sky is blue';
      }),
    );
    expect((fact as any).createdAt).toBeInstanceOf(Date);

    const emissions: number[] = [];
    const sub = facts().query().observeCount(false).subscribe((n) => emissions.push(n));
    await Promise.resolve();
    sub.unsubscribe();
    expect(emissions).toEqual([1]);

    // Positive control: a matching query finds the row, a non-matching one does not.
    expect(await settings().query(Q.where('key', 'harness.key')).fetchCount()).toBe(1);
    expect(await settings().query(Q.where('key', 'no-such-key')).fetchCount()).toBe(0);

    await resetDatabase();
    expect(await settings().query().fetchCount()).toBe(0);
    expect(await facts().query().fetchCount()).toBe(0);
  });
});

describe('in-memory WatermelonDB under the fake clock', () => {
  it('writes and reads rows with timers faked', async () => {
    useFakeClock('2026-10-09T00:00:00Z');
    await setSetting('harness.fake', 'v2');
    expect(await getSetting('harness.fake')).toBe('v2');
    const fact = await database.write(() =>
      facts().create((f: any) => {
        f.statement = 'clocked';
      }),
    );
    expect((fact as any).createdAt.getTime()).toBe(Date.parse('2026-10-09T00:00:00Z'));
    expect(await settings().query(Q.where('key', 'harness.fake')).fetchCount()).toBe(1);
    await resetDatabase();
    expect(await settings().query().fetchCount()).toBe(0);
  });
});
