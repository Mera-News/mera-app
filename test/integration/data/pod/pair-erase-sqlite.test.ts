// The erase on pairing, on a real SQLite file through the real SQLiteAdapter. Only the driver differs from a
// phone: WatermelonDB's node driver wants better-sqlite3, which the app does not install, so node:sqlite stands
// in. The batch is one real transaction, so a failure part-way must roll every earlier statement back.
//
// node:sqlite ships with the Node the app's CI runs (26), so a missing module fails this file rather than skipping it.
import fs from 'node:fs';
import path from 'node:path';
import { sanitizedRaw } from '@nozbe/watermelondb/RawRecord';

import database from '@/lib/database';
import schema from '@/lib/database/schema';
import { appKeepSettingKeys } from '@/lib/own-services/erase-keep';
import { applySnapshot } from '@/lib/sync/apply';
import { COMMAND_REGISTRY_VERSION } from '@/lib/sync/command';
import type { Snapshot } from '@/lib/sync/snapshot';
import { PAIRING_ERASED_KEY, PAIRING_KEEP_SETTING_KEYS, SYNC_TABLES } from '@/lib/sync/tables';
import { resetDatabase } from '@/test/helpers/db';

jest.mock('expo-file-system', () => require('@/test/helpers/fs').fileSystemModule);
jest.mock('expo-file-system/legacy', () => ({ getFreeDiskStorageAsync: async () => 1 }));

type Handle = { exec: (sql: string) => void; prepare: (sql: string) => { all: () => Record<string, unknown>[] } };
const scope = globalThis as unknown as { mockSqliteHandle: Handle };

/** What the node driver calls on a better-sqlite3 handle. */
jest.mock(
  'better-sqlite3',
  () =>
    class {
      open = true;
      memory = false;
      private readonly db: InstanceType<typeof import('node:sqlite').DatabaseSync>;
      constructor(file: string) {
        const { DatabaseSync } = jest.requireActual('node:sqlite') as typeof import('node:sqlite');
        this.db = new DatabaseSync(file);
        this.db.exec('pragma journal_mode = WAL');
        (globalThis as unknown as { mockSqliteHandle: unknown }).mockSqliteHandle = this.db;
      }
      prepare(sql: string) {
        const statement = this.db.prepare(sql);
        return {
          run: (args: never[] = []) => statement.run(...args),
          get: (args: never[] = []) => statement.get(...args),
          all: (args: never[] = []) => statement.all(...args),
        };
      }
      exec(sql: string) {
        this.db.exec(sql);
      }
      transaction(block: () => void) {
        return () => {
          this.db.exec('begin');
          try {
            block();
            this.db.exec('commit');
          } catch (error) {
            this.db.exec('rollback');
            throw error;
          }
        };
      }
      close() {
        this.db.close();
        this.open = false;
      }
      pragma(sql: string, options?: { simple?: boolean }) {
        const row = this.db.prepare(`pragma ${sql}`).get() as Record<string, unknown> | undefined;
        return options?.simple && row ? Object.values(row)[0] : row;
      }
    },
  { virtual: true },
);

jest.mock('@nozbe/watermelondb/adapters/sqlite/makeDispatcher', () =>
  jest.requireActual(require.resolve('@nozbe/watermelondb/adapters/sqlite/makeDispatcher/index.js')),
);

jest.mock('@/lib/database/index', () => {
  const { Database } = jest.requireActual('@nozbe/watermelondb') as typeof import('@nozbe/watermelondb');
  const SQLiteAdapter = jest.requireActual('@nozbe/watermelondb/adapters/sqlite').default;
  const { default: appSchema } = require('@/lib/database/schema');
  const models = [
    'Fact', 'ArticleSuggestion', 'ArticleSuggestionFact', 'Conversation', 'Message', 'UserPersona', 'PublicationVisit',
    'SavedArticleSuggestion', 'ArticleFeedback', 'Setting', 'InferenceJob', 'SchedulerJob', 'Topic', 'Location',
    'PublicationPreference', 'PersonaSuppression', 'PersonaChangeLog', 'StoryImpression', 'Notification',
    'PersonaSummaryString', 'TrackedStory', 'TranslationCache', 'FactCheckRecord', 'UserPublicationSubscription', 'DeclinedTopic',
  ].map((name) => require(`@/lib/database/models/${name}`).default);
  const nodeFs = jest.requireActual('node:fs') as typeof import('node:fs');
  const nodeOs = jest.requireActual('node:os') as typeof import('node:os');
  const nodePath = jest.requireActual('node:path') as typeof import('node:path');
  const dbPath = nodePath.join(nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), 'mera-pair-')), 'watermelon.db');
  return {
    __esModule: true,
    dbPath,
    default: new Database({ adapter: new SQLiteAdapter({ schema: appSchema, dbName: dbPath, jsi: false }), modelClasses: models }),
  };
});

const hasNodeSqlite = (() => {
  try {
    require('node:sqlite');
    return true;
  } catch {
    return false;
  }
})();

const LOCAL = { schemaVersion: schema.version as number, registry: COMMAND_REGISTRY_VERSION as number };
const { dbPath } = jest.requireMock('@/lib/database/index') as { dbPath: string };

const put = (table: string, rows: Record<string, unknown>[]) =>
  database.write(async () => {
    const col = database.get(table as never);
    await database.batch(
      ...rows.map((row) =>
        col.prepareCreate((rec: any) => {
          rec._raw = sanitizedRaw({ ...row, _status: 'created', _changed: '' }, col.schema);
        }),
      ),
    );
  });

/** Every table on the file, every column, in a stable order. */
function dumpFile(): string {
  const tables = scope.mockSqliteHandle
    .prepare("select name from sqlite_master where type = 'table' and name not like 'sqlite_%' order by name")
    .all()
    .map((r) => String(r.name));
  return JSON.stringify(Object.fromEntries(tables.map((t) => [t, scope.mockSqliteHandle.prepare(`select * from "${t}" order by 1`).all()])));
}

const rowIds = (table: string) =>
  scope.mockSqliteHandle.prepare(`select id from "${table}" where _status != 'deleted' order by id`).all().map((r) => String(r.id));
const settingsFile = () =>
  Object.fromEntries(scope.mockSqliteHandle.prepare("select key, value from settings where _status != 'deleted'").all().map((r) => [String(r.key), String(r.value)]));

async function seedPhone() {
  await put('facts', [{ id: 'phone-fact-1', statement: 'PHONE', created_at: 1, updated_at: 1 }, { id: 'phone-fact-2', statement: 'PHONE 2', created_at: 1, updated_at: 1 }]);
  await put('conversations', [{ id: 'conv-1', surface: 'chat', created_at: 1 }]);
  await put('messages', [{ id: 'msg-1', conversation_id: 'conv-1', role: 'user', content: 'PHONE CHAT', created_at: 1 }]);
  await put('user_personas', [{ id: 'persona-1', server_id: 's', user_id: 'u', processing_mode: 'cloud', onboarding_stage: 'done', created_at: 1, updated_at: 1 }]);
  await put('settings', [
    { id: 's1', key: 'has_launched', value: '1' },
    { id: 's2', key: 'cached_user_id', value: 'u' },
    { id: 's3', key: 'theme', value: 'dark' },
    { id: 's4', key: 'tutorial_chapter_a_completed', value: '1' },
    { id: 's5', key: 'pending_notification_hours', value: '9' },
    { id: 's6', key: 'app_language', value: 'nl' },
    { id: 's7', key: 'onboarding_done', value: 'false' },
  ]);
}

const serverSnapshot = (over: Record<string, unknown[]> = {}): Snapshot => ({
  ...LOCAL,
  tables: Object.fromEntries(
    SYNC_TABLES.map((t) => [t.name, { hash: `h-${t.name}`, mode: t.mode, rows: over[t.name] ?? [] }]),
  ),
}) as Snapshot;

it('runs on a Node that has node:sqlite', () => expect(hasNodeSqlite).toBe(true));

describe('the erase and apply on real SQLite', () => {
  beforeEach(async () => {
    await resetDatabase();
    await seedPhone();
  });
  afterAll(() => fs.rmSync(path.dirname(dbPath), { recursive: true, force: true }));

  it('a served row that collides with a deleted row fails mid-batch and every row and setting is as before', async () => {
    // A row marked deleted still holds its id on disk, so creating it again fails after earlier statements ran.
    await database.write(async () => {
      const [ghost] = await database.get('facts').query().fetch();
      await ghost.markAsDeleted();
    });
    const before = dumpFile();
    const snapshot = serverSnapshot({
      facts: [{ id: 'server-fact-1', statement: 'SERVER', created_at: 1, updated_at: 1 }],
      user_publication_subscriptions: [{ id: 'sub-1' }],
      settings: [{ key: 'app_language', value: 'de' }],
    });
    const ghostId = scope.mockSqliteHandle.prepare("select id from facts where _status = 'deleted'").all()[0].id as string;
    snapshot.tables.facts.rows!.push({ id: ghostId, statement: 'COLLIDES', created_at: 1, updated_at: 1 });

    await expect(applySnapshot(snapshot, { local: LOCAL, erase: { keepSettingKeys: await appKeepSettingKeys() } })).rejects.toThrow();

    expect(dumpFile()).toBe(before);
  });

  it('a snapshot with a repeated row id is refused with every row as before', async () => {
    const before = dumpFile();
    const snapshot = serverSnapshot({ facts: [{ id: 'dup', statement: 'a' }, { id: 'dup', statement: 'b' }] });
    await expect(applySnapshot(snapshot, { local: LOCAL, erase: { keepSettingKeys: await appKeepSettingKeys() } })).rejects.toThrow();
    expect(dumpFile()).toBe(before);
  });

  it('a snapshot with no rows for a served table is refused with every row as before', async () => {
    const before = dumpFile();
    const snapshot = serverSnapshot();
    delete (snapshot.tables.locations as { rows?: unknown }).rows;
    await expect(applySnapshot(snapshot, { local: LOCAL, erase: { keepSettingKeys: await appKeepSettingKeys() } })).rejects.toThrow();
    expect(dumpFile()).toBe(before);
  });

  it('a good snapshot leaves only the kept rows and settings and the server rows', async () => {
    const snapshot = serverSnapshot({
      facts: [{ id: 'server-fact-1', statement: 'SERVER', created_at: 1, updated_at: 1 }],
      settings: [{ key: 'app_language', value: 'de' }],
    });

    await applySnapshot(snapshot, { local: LOCAL, erase: { keepSettingKeys: await appKeepSettingKeys() } });

    expect(rowIds('facts')).toEqual(['server-fact-1']);
    expect(rowIds('conversations')).toEqual([]);
    expect(rowIds('messages')).toEqual([]);
    expect(rowIds('user_personas')).toEqual(['persona-1']);
    const settings = settingsFile();
    expect(settings).toMatchObject({
      has_launched: '1', cached_user_id: 'u', theme: 'dark', tutorial_chapter_a_completed: '1', app_language: 'de', onboarding_done: 'true',
    });
    expect(settings.pending_notification_hours).toBeUndefined();
    expect(Number(settings[PAIRING_ERASED_KEY])).toBeGreaterThan(0);
    const allowed = new Set([...PAIRING_KEEP_SETTING_KEYS, 'tutorial_chapter_a_completed', 'app_language', 'onboarding_done', PAIRING_ERASED_KEY, 'sync_notifications_seen']);
    expect(Object.keys(settings).filter((k) => !allowed.has(k))).toEqual([]);
  });
});
