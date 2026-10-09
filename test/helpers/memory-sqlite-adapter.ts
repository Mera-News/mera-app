// In-memory stand-in for `@nozbe/watermelondb/adapters/sqlite`, wired by
// jest.setup.integration.js. The real lib/database/index.ts runs unchanged, so
// its modelClasses list cannot drift. It extends the LokiJS adapter, ignores
// `jsi`, `migrations` and `onSetUpError`, and starts at the schema version, so
// migrations.ts (the only raw SQL) never runs.
//
// Known Loki gaps versus SQLite:
// - no SQLite UNIQUE error (code 1555) on a duplicate unique value;
// - `Q.like` matching and NULL sort order may differ;
// - `unsafeFetchRaw` is supported;
// - raw SQL lives only in migrations.ts, which never runs here.
import type { AppSchema } from '@nozbe/watermelondb';

const LokiJSAdapter = jest.requireActual('@nozbe/watermelondb/adapters/lokijs').default;

class MemorySqliteAdapter extends LokiJSAdapter {
  constructor({ schema }: { schema: AppSchema }) {
    super({
      schema,
      useWebWorker: false,
      useIncrementalIndexedDB: false,
      extraLokiOptions: { autosave: false },
    });
  }
}

module.exports = { __esModule: true, default: MemorySqliteAdapter };
