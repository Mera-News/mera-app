import { resolveLaunchRoute } from '../launch-route';

describe('resolveLaunchRoute — cold-start routing matrix', () => {
  it('no identity → /login (first install / logged out)', () => {
    expect(resolveLaunchRoute({ hasIdentity: false, pinSet: false, locked: false })).toBe('/login');
    // identity is the only gate to /login — PIN/locked are irrelevant without it.
    expect(resolveLaunchRoute({ hasIdentity: false, pinSet: true, locked: true })).toBe('/login');
  });

  it('identity but no PIN → /pin-setup (one-time mandatory setup)', () => {
    expect(resolveLaunchRoute({ hasIdentity: true, pinSet: false, locked: false })).toBe('/pin-setup');
    expect(resolveLaunchRoute({ hasIdentity: true, pinSet: false, locked: true })).toBe('/pin-setup');
  });

  it('identity + PIN set + locked → /pin-lock', () => {
    expect(resolveLaunchRoute({ hasIdentity: true, pinSet: true, locked: true })).toBe('/pin-lock');
  });

  it('identity + PIN set + unlocked → /logged-in', () => {
    expect(resolveLaunchRoute({ hasIdentity: true, pinSet: true, locked: false })).toBe('/logged-in');
  });
});
