// The allowlist is only trustworthy if it is checked against the LIVE schema.
//
// The failure this exists to prevent is silent: a later wave adds a table of
// user data, nobody thinks about backup, and that data simply stops being
// carried. Nothing would fail — the exporter would iterate the tables it knows
// about and write a complete-looking blob. So the schema is parsed here and set
// equality is asserted, which turns "nobody decided" into a red suite.
//
// schema.ts is read as TEXT rather than imported. Importing it pulls in
// WatermelonDB, and `lib/database/index.ts` opens SQLite at module evaluation —
// this file needs the table names, not a database.

import fs from 'fs';
import path from 'path';

import {
  BACKUP_SETTING_KEYS,
  BACKUP_SETTING_KEY_PREFIXES,
  BACKUP_TABLES,
  EXCLUDED_TABLES,
  FORBIDDEN_SETTING_KEYS,
  TABLE_CAP_ORDER_COLUMN,
  TABLE_ROW_CAPS,
  isBackedUpSettingKey,
} from '../allowlist';

const SCHEMA_PATH = path.resolve(__dirname, '../../database/schema.ts');

function liveSchema(): { version: number; tables: string[]; columns: Record<string, string[]> } {
  const src = fs.readFileSync(SCHEMA_PATH, 'utf8');
  const version = Number(/version:\s*(\d+)/.exec(src)?.[1]);
  const tables = [...src.matchAll(/tableSchema\(\{\s*name:\s*'([^']+)'/g)].map((m) => m[1]);

  const columns: Record<string, string[]> = {};
  for (const block of src.split('tableSchema({').slice(1)) {
    const table = /name:\s*'([^']+)'/.exec(block)?.[1];
    if (!table) continue;
    columns[table] = [...block.matchAll(/\{\s*name:\s*'([^']+)',\s*type:/g)].map((m) => m[1]);
  }
  return { version, tables, columns };
}

describe('backup allowlist vs the live schema', () => {
  const { version, tables, columns } = liveSchema();

  it('parsed a schema that actually has tables in it', () => {
    // Without this the set checks below pass vacuously if the file ever moves
    // or the tableSchema call shape changes.
    expect(version).toBeGreaterThan(0);
    expect(tables.length).toBeGreaterThan(15);
  });

  it('classifies every live table as either backed up or excluded', () => {
    const classified = new Set([...BACKUP_TABLES, ...Object.keys(EXCLUDED_TABLES)]);
    const unclassified = tables.filter((t) => !classified.has(t));
    // A new table lands here. Decide which side it belongs on — do not delete
    // this assertion to make the suite green.
    expect(unclassified).toEqual([]);
  });

  it('names no table that the schema does not have', () => {
    const live = new Set(tables);
    const phantom = [...BACKUP_TABLES, ...Object.keys(EXCLUDED_TABLES)].filter((t) => !live.has(t));
    expect(phantom).toEqual([]);
  });

  it('puts no table on both sides', () => {
    const overlap = BACKUP_TABLES.filter((t) => t in EXCLUDED_TABLES);
    expect(overlap).toEqual([]);
  });

  it('gives every exclusion a stated reason', () => {
    for (const [table, reason] of Object.entries(EXCLUDED_TABLES)) {
      expect(reason.length).toBeGreaterThan(20);
      expect(table).not.toBe('');
    }
  });

  it('orders parents before the rows that reference them', () => {
    // The importer seeds _raw.id and writes in this order, so a child arriving
    // before its parent dangles rather than throwing.
    const at = (t: string) => BACKUP_TABLES.indexOf(t);
    expect(at('facts')).toBeLessThan(at('topics'));            // topics.fact_id
    expect(at('topics')).toBeLessThan(at('tracked_stories'));  // tracked_stories.topic_id
    expect(at('facts')).toBeLessThan(at('persona_summary_strings'));
  });

  it('carries no feed or chat data, which is the whole point of the allowlist', () => {
    // Owner call 2026-08-18: back up the persona and what the user curated by
    // hand, not the article stream that flowed past it. `saved_article_suggestions`
    // and `publication_visits` are the deliberate exceptions — a save is an act
    // of curation, and reading history is the user's own record.
    for (const t of ['article_suggestions', 'conversations', 'messages', 'article_feedback']) {
      expect(BACKUP_TABLES).not.toContain(t);
      expect(EXCLUDED_TABLES).toHaveProperty(t);
    }
    expect(BACKUP_TABLES).toContain('saved_article_suggestions');
    expect(BACKUP_TABLES).toContain('publication_visits');
  });

  it('caps only tables it actually backs up', () => {
    for (const table of Object.keys(TABLE_ROW_CAPS)) {
      expect(BACKUP_TABLES).toContain(table);
    }
  });

  it('gives every capped table an order column, because a cap without one is arbitrary', () => {
    // A WatermelonDB id is a random string. Paging a capped table by id keeps
    // an ARBITRARY N of the user's rows rather than the newest N, and a
    // small-fixture round-trip test passes either way. So the two records must
    // have identical keys.
    expect(Object.keys(TABLE_CAP_ORDER_COLUMN).sort()).toEqual(Object.keys(TABLE_ROW_CAPS).sort());
  });

  it('names an order column that exists on that table', () => {
    for (const [table, column] of Object.entries(TABLE_CAP_ORDER_COLUMN)) {
      expect(columns[table]).toBeDefined();
      expect(columns[table]).toContain(column);
    }
  });

  it('parsed real columns, so the check above is not vacuous', () => {
    expect(columns.messages).toContain('conversation_id');
    expect(columns.settings).toEqual(expect.arrayContaining(['key', 'value']));
  });
});

describe('settings key filter', () => {
  it('never allows a forbidden key', () => {
    // The tripwire. Adding a forbidden key to the allowlist fails here rather
    // than shipping.
    const leaked = BACKUP_SETTING_KEYS.filter((k) => k in FORBIDDEN_SETTING_KEYS);
    expect(leaked).toEqual([]);
  });

  it('refuses cached_user_id specifically', () => {
    // Called out on its own because it is the one that destroys the restore it
    // is part of: identity-gate reads it and triggers wipeAndProceed.
    expect(isBackedUpSettingKey('cached_user_id')).toBe(false);
    expect(FORBIDDEN_SETTING_KEYS.cached_user_id).toContain('wipeAndProceed');
  });

  it('refuses every other forbidden key', () => {
    for (const key of Object.keys(FORBIDDEN_SETTING_KEYS)) {
      expect(isBackedUpSettingKey(key)).toBe(false);
    }
  });

  it('carries the allowlisted preference keys', () => {
    for (const key of BACKUP_SETTING_KEYS) {
      expect(isBackedUpSettingKey(key)).toBe(true);
    }
  });

  it('carries a dynamic key family by prefix', () => {
    expect(isBackedUpSettingKey('headline_depth:GB')).toBe(true);
    expect(isBackedUpSettingKey('headline_depth:')).toBe(true);
  });

  it('rejects an unknown key rather than defaulting it in', () => {
    // The default has to be "do not carry this to another device".
    expect(isBackedUpSettingKey('some_future_wave_key')).toBe(false);
    expect(isBackedUpSettingKey('feed_sync_machine_state')).toBe(false);
    expect(isBackedUpSettingKey('calibration.scoring_overrides')).toBe(false);
  });

  it('declares no empty prefix, which would allow everything', () => {
    for (const p of BACKUP_SETTING_KEY_PREFIXES) {
      expect(p.length).toBeGreaterThan(0);
    }
  });
});
