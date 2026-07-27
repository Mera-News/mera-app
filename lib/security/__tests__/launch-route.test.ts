import { resolveLaunchRoute } from '../launch-route';

describe('resolveLaunchRoute — cold-start routing matrix', () => {
  it('no identity → /login (first install / logged out)', () => {
    expect(
      resolveLaunchRoute({ hasIdentity: false, lockEnabled: false, pinSet: false, locked: false }),
    ).toBe('/login');
    // identity is the only gate to /login — the lock state is irrelevant without it.
    expect(
      resolveLaunchRoute({ hasIdentity: false, lockEnabled: true, pinSet: true, locked: true }),
    ).toBe('/login');
  });

  it('identity + lock off → /logged-in, never a setup screen', () => {
    // The default state for a fresh install and for every user who never opted
    // in. The gate must not force PIN setup.
    expect(
      resolveLaunchRoute({ hasIdentity: true, lockEnabled: false, pinSet: false, locked: false }),
    ).toBe('/logged-in');
    expect(
      resolveLaunchRoute({ hasIdentity: true, lockEnabled: false, pinSet: false, locked: true }),
    ).toBe('/logged-in');
  });

  it('lock off with a stale PIN record still → /logged-in', () => {
    // A user who set a PIN under the old mandatory flow. pin-store.init clears
    // the record, but the routing decision must not depend on that having run.
    expect(
      resolveLaunchRoute({ hasIdentity: true, lockEnabled: false, pinSet: true, locked: true }),
    ).toBe('/logged-in');
  });

  it('lock on but no PIN record → /logged-in (never a screen no entry can satisfy)', () => {
    expect(
      resolveLaunchRoute({ hasIdentity: true, lockEnabled: true, pinSet: false, locked: true }),
    ).toBe('/logged-in');
  });

  it('lock on + PIN set + locked → /pin-lock', () => {
    expect(
      resolveLaunchRoute({ hasIdentity: true, lockEnabled: true, pinSet: true, locked: true }),
    ).toBe('/pin-lock');
  });

  it('lock on + PIN set + unlocked → /logged-in', () => {
    expect(
      resolveLaunchRoute({ hasIdentity: true, lockEnabled: true, pinSet: true, locked: false }),
    ).toBe('/logged-in');
  });
});
