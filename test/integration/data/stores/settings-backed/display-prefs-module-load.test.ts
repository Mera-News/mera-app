/* eslint-disable @typescript-eslint/no-require-imports -- the probe must require after resetModules */
// MeraLogo reads display-prefs-store, so a module-level database import would
// pull WatermelonDB into every card suite (which then dies on initializeJSI).
// Its own file: it resets the module registry, which would split every other
// test's copy of the database from the one the stores lazily require.
//
// The probe stands in for the SQLite adapter edge, which lib/database/index.ts
// constructs at import time. jest.isolateModules is not enough: the integration
// setup has already cached the adapter in the main registry, and an isolated
// require falls back to it.
it('requiring display-prefs-store does not construct the database', () => {
  let mockConstructed = 0;
  jest.resetModules();
  jest.doMock('@nozbe/watermelondb/adapters/sqlite', () => {
    const Real = require('@/test/helpers/memory-sqlite-adapter').default;
    return {
      __esModule: true,
      default: class extends Real {
        constructor(options: unknown) {
          super(options);
          mockConstructed += 1;
        }
      },
    };
  });
  try {
    require('@/lib/stores/display-prefs-store');
    expect(mockConstructed).toBe(0);
    // Positive control: the probe does see the database when something loads it.
    require('@/lib/database/services/setting-service');
    expect(mockConstructed).toBe(1);
  } finally {
    jest.doMock('@nozbe/watermelondb/adapters/sqlite', () => require('@/test/helpers/memory-sqlite-adapter'));
  }
});
