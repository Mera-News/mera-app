// v57 adds article_suggestions.score_failed_at. The in-memory test adapter never runs
// migrations.ts, so this replays the real SQL WatermelonDB emits against node:sqlite: a v56
// article_suggestions table with a row in it, then the v57 steps.
import { DatabaseSync } from 'node:sqlite';
import { appSchema, tableSchema } from '@nozbe/watermelondb';
import type { AppSchema, SchemaMigrations } from '@nozbe/watermelondb';
// Untyped module: the SQL WatermelonDB's SQLite adapter runs for a schema and a migration.
const { encodeMigrationSteps, encodeSchema } = require('@nozbe/watermelondb/adapters/sqlite/encodeSchema') as {
  encodeSchema: (schema: AppSchema) => string;
  encodeMigrationSteps: (steps: SchemaMigrations['sortedMigrations'][number]['steps']) => string;
};
import schema from '@/lib/database/schema';
import migrations from '@/lib/database/migrations';

const migList: { toVersion: number; steps: any[] }[] = (migrations as any).sortedMigrations;
const v57 = migList.find((m) => m.toVersion === 57);

describe('v57: score_failed_at on article_suggestions', () => {
  it('is one additive, optional number column', () => {
    expect(schema.version).toBe(57);
    expect(v57?.steps).toEqual([
      {
        type: 'add_columns',
        table: 'article_suggestions',
        columns: [{ name: 'score_failed_at', type: 'number', isOptional: true }],
      },
    ]);
  });

  it('upgrades an existing database, keeping its rows, with the column NULL', () => {
    const current = schema.tables.article_suggestions;
    const v56Table = tableSchema({
      name: 'article_suggestions',
      columns: current.columnArray.filter((c) => c.name !== 'score_failed_at'),
    });
    const db = new DatabaseSync(':memory:');
    db.exec(encodeSchema(appSchema({ version: 56, tables: [v56Table] })));
    db.prepare(
      "insert into article_suggestions (id, _status, _changed, article_id, status) values ('r1', 'created', '', 'a1', 'unscored')",
    ).run();

    db.exec(encodeMigrationSteps(v57!.steps as any));

    expect(db.prepare('select id, status, score_failed_at from article_suggestions').all()).toEqual([
      { id: 'r1', status: 'unscored', score_failed_at: null },
    ]);
  });
});
