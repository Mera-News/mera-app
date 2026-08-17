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
  TABLE_ROW_CAPS,
  isBackedUpSettingKey,
} from '../allowlist';

const SCHEMA_PATH = path.resolve(__dirname, '../../database/schema.ts');

function liveSchema(): { version: number; tables: string[] } {
  const src = fs.readFileSync(SCHEMA_PATH, 'utf8');
  const version = Number(/version:\s*(\d+)/.exec(src)?.[1]);
  const tables = [...src.matchAll(/tableSchema\(\{\s*name:\s*'([^']+)'/g)].map((m) => m[1]);
  return { version, tables };
}

describe('backup allowlist vs the live schema', () => {
  const { version, tables } = liveSchema();

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

  it('orders conversations before messages, and facts before their dependants', () => {
    // The importer seeds _raw.id and writes in this order, so a child arriving
    // before its parent dangles rather than throwing.
    const at = (t: string) => BACKUP_TABLES.indexOf(t);
    expect(at('conversations')).toBeLessThan(at('messages'));
    expect(at('facts')).toBeLessThan(at('persona_summary_strings'));
    expect(at('facts')).toBeLessThan(at('persona_change_log'));
  });

  it('caps only tables it actually backs up', () => {
    for (const table of Object.keys(TABLE_ROW_CAPS)) {
      expect(BACKUP_TABLES).toContain(table);
    }
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
