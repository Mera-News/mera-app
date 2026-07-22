// §8 structural assertions for lib/database/migrations.ts
// Pure data — no WatermelonDB native runtime needed.
// schemaMigrations() returns { sortedMigrations, minVersion, maxVersion, validated }

import schema from '../schema';
import migrations from '../migrations';

// The schemaMigrations object uses `sortedMigrations` (sorted ascending by toVersion)
const migList: Array<{ toVersion: number; steps: any[] }> = (migrations as any).sortedMigrations;

describe('migrations shape', () => {
  it('sortedMigrations is a non-empty array', () => {
    expect(Array.isArray(migList)).toBe(true);
    expect(migList.length).toBeGreaterThan(0);
  });

  it('every migration has a numeric toVersion', () => {
    for (const m of migList) {
      expect(typeof m.toVersion).toBe('number');
      expect(Number.isInteger(m.toVersion)).toBe(true);
      expect(m.toVersion).toBeGreaterThan(0);
    }
  });

  it('every migration has a steps array', () => {
    for (const m of migList) {
      expect(Array.isArray(m.steps)).toBe(true);
    }
  });

  it('toVersions are sorted in ascending order (sortedMigrations contract)', () => {
    const versions = migList.map((m) => m.toVersion);
    for (let i = 1; i < versions.length; i++) {
      expect(versions[i]).toBeGreaterThan(versions[i - 1]);
    }
  });

  it('toVersions are contiguous (no gaps)', () => {
    const versions = migList.map((m) => m.toVersion).sort((a, b) => a - b);
    const min = versions[0];
    const max = versions[versions.length - 1];
    for (let v = min; v <= max; v++) {
      expect(versions).toContain(v);
    }
  });

  it('has no duplicate toVersion entries', () => {
    const versions = migList.map((m) => m.toVersion);
    const unique = new Set(versions);
    expect(unique.size).toBe(versions.length);
  });

  it('maxVersion property matches schema.version', () => {
    expect((migrations as any).maxVersion).toBe(schema.version);
  });

  it('max(toVersion) in sortedMigrations equals schema.version', () => {
    const maxVersion = Math.max(...migList.map((m) => m.toVersion));
    expect(maxVersion).toBe(schema.version);
  });
});

describe('migration step types', () => {
  it('every step object is non-null', () => {
    for (const m of migList) {
      for (const step of m.steps) {
        expect(step).not.toBeNull();
      }
    }
  });

  it('every step has a type string', () => {
    for (const m of migList) {
      for (const step of m.steps) {
        if (step !== null && step !== undefined) {
          expect(typeof step.type).toBe('string');
        }
      }
    }
  });

  it('create_table steps have a schema.name property', () => {
    for (const m of migList) {
      for (const step of m.steps) {
        if (step && step.type === 'create_table') {
          expect(step.schema).toBeDefined();
          expect(typeof step.schema.name).toBe('string');
          expect(step.schema.name.length).toBeGreaterThan(0);
        }
      }
    }
  });

  it('add_columns steps reference a table name', () => {
    for (const m of migList) {
      for (const step of m.steps) {
        if (step && step.type === 'add_columns') {
          expect(typeof step.table).toBe('string');
          expect(step.table.length).toBeGreaterThan(0);
        }
      }
    }
  });
});

describe('specific migration versions', () => {
  const byVersion = new Map(migList.map((m) => [m.toVersion, m]));

  it('v2 creates the inference_jobs table', () => {
    const m = byVersion.get(2);
    expect(m).toBeDefined();
    const createStep = m!.steps.find(
      (s: any) => s && s.type === 'create_table' && s.schema?.name === 'inference_jobs',
    );
    expect(createStep).toBeDefined();
  });

  it('v22 creates publication_visits table', () => {
    const m = byVersion.get(22);
    expect(m).toBeDefined();
    const createStep = m!.steps.find(
      (s: any) => s && s.type === 'create_table' && s.schema?.name === 'publication_visits',
    );
    expect(createStep).toBeDefined();
  });

  it('v23 adds snapshot columns to publication_visits', () => {
    const m = byVersion.get(23);
    expect(m).toBeDefined();
    const addStep = m!.steps.find(
      (s: any) => s && s.type === 'add_columns' && s.table === 'publication_visits',
    );
    expect(addStep).toBeDefined();
    const colNames = addStep.columns.map((c: any) => c.name);
    expect(colNames).toContain('title_en');
    expect(colNames).toContain('title_original');
    expect(colNames).toContain('image_url');
    expect(colNames).toContain('pub_date');
  });

  it('v25 creates scheduler_jobs table', () => {
    const m = byVersion.get(25);
    expect(m).toBeDefined();
    const createStep = m!.steps.find(
      (s: any) => s && s.type === 'create_table' && s.schema?.name === 'scheduler_jobs',
    );
    expect(createStep).toBeDefined();
  });

  it('v10 adds notifications_enabled to user_personas', () => {
    const m = byVersion.get(10);
    expect(m).toBeDefined();
    const addStep = m!.steps.find(
      (s: any) => s && s.type === 'add_columns' && s.table === 'user_personas',
    );
    expect(addStep).toBeDefined();
    const colNames = addStep.columns.map((c: any) => c.name);
    expect(colNames).toContain('notifications_enabled');
  });

  it('v17 has an empty steps array (intentional no-op)', () => {
    const m = byVersion.get(17);
    expect(m).toBeDefined();
    expect(m!.steps).toHaveLength(0);
  });

  it('v18 adds onboarding_stage to user_personas', () => {
    const m = byVersion.get(18);
    expect(m).toBeDefined();
    const addStep = m!.steps.find(
      (s: any) => s && s.type === 'add_columns' && s.table === 'user_personas',
    );
    expect(addStep).toBeDefined();
  });

  it('v24 has steps (drops synced_suggestion_ids)', () => {
    const m = byVersion.get(24);
    expect(m).toBeDefined();
    expect(m!.steps.length).toBeGreaterThan(0);
  });

  it('v40 adds topic-linked columns to tracked_stories', () => {
    const m = byVersion.get(40);
    expect(m).toBeDefined();
    const addStep = m!.steps.find(
      (s: any) => s && s.type === 'add_columns' && s.table === 'tracked_stories',
    );
    expect(addStep).toBeDefined();
    const colNames = addStep.columns.map((c: any) => c.name);
    expect(colNames).toContain('topic_id');
    expect(colNames).toContain('topic_text');
    expect(colNames).toContain('member_snapshots_json');
  });

  it('v42 adds processed_at to article_feedback', () => {
    const m = byVersion.get(42);
    expect(m).toBeDefined();
    const addStep = m!.steps.find(
      (s: any) => s && s.type === 'add_columns' && s.table === 'article_feedback',
    );
    expect(addStep).toBeDefined();
    const colNames = addStep.columns.map((c: any) => c.name);
    expect(colNames).toContain('processed_at');
  });

  it('v44 additively adds seen_pub_watermark_ms to tracked_stories', () => {
    const m = byVersion.get(44);
    expect(m).toBeDefined();
    // Additive only — never a drop/recreate of the long-lived user-owned table.
    const creates = m!.steps.filter(
      (s: any) => s && s.type === 'create_table' && s.schema?.name === 'tracked_stories',
    );
    expect(creates).toHaveLength(0);
    const addStep = m!.steps.find(
      (s: any) => s && s.type === 'add_columns' && s.table === 'tracked_stories',
    );
    expect(addStep).toBeDefined();
    const colNames = addStep.columns.map((c: any) => c.name);
    expect(colNames).toEqual(['seen_pub_watermark_ms']);
    expect(!!addStep.columns[0].isOptional).toBe(true);
  });

  it('v32 creates article_suggestions with cluster_memberships_json', () => {
    const m = byVersion.get(32);
    expect(m).toBeDefined();
    const createStep = m!.steps.find(
      (s: any) => s && s.type === 'create_table' && s.schema?.name === 'article_suggestions',
    );
    expect(createStep).toBeDefined();
    const colNames = createStep.schema.columnArray.map((c: any) => c.name);
    expect(colNames).toContain('cluster_memberships_json');
    expect(colNames).not.toContain('cluster_ids_json');
  });
});

// ── P7b: v37/v41 rewritten additively (no more drop/recreate of the cache) ──
describe('article_suggestions additive migrations (v37 / v41)', () => {
  const byVersion = new Map(migList.map((m) => [m.toVersion, m]));

  // A raw SQL step touching a table (DROP/DELETE/etc.) — inspect the embedded
  // SQL string across the known WatermelonDB unsafeExecuteSql shapes.
  const sqlOf = (step: any): string => {
    if (!step || step.type !== 'sql') return '';
    return String(step.sql ?? step.text ?? JSON.stringify(step));
  };

  it('v37 has no sql step mentioning article_suggestions', () => {
    const m = byVersion.get(37)!;
    const offending = m.steps.filter((s: any) => /article_suggestion/.test(sqlOf(s)));
    expect(offending).toHaveLength(0);
  });

  it('v37 does not create_table article_suggestions or article_suggestion_facts', () => {
    const m = byVersion.get(37)!;
    const creates = m.steps.filter(
      (s: any) =>
        s &&
        s.type === 'create_table' &&
        (s.schema?.name === 'article_suggestions' ||
          s.schema?.name === 'article_suggestion_facts'),
    );
    expect(creates).toHaveLength(0);
  });

  it('v37 adds the 11 persona-v3 scorer/audit columns to article_suggestions', () => {
    const m = byVersion.get(37)!;
    const addStep = m.steps.find(
      (s: any) => s && s.type === 'add_columns' && s.table === 'article_suggestions',
    );
    expect(addStep).toBeDefined();
    const colNames = addStep.columns.map((c: any) => c.name).sort();
    expect(colNames).toEqual(
      [
        'category',
        'computed_score',
        'entities_json',
        'event_type',
        'geo_tags_json',
        'headline_scope',
        'matched_topics_json',
        'max_cluster_size',
        'raw_score',
        'score_components_json',
        'stable_cluster_id',
      ].sort(),
    );
    // stable_cluster_id keeps its indexed flag through addColumns.
    const stable = addStep.columns.find((c: any) => c.name === 'stable_cluster_id');
    expect(!!stable.isIndexed).toBe(true);
    expect(!!stable.isOptional).toBe(true);
  });

  it('v37 has no add_columns step for article_suggestion_facts (unchanged since v34)', () => {
    const m = byVersion.get(37)!;
    const facts = m.steps.filter(
      (s: any) => s && s.type === 'add_columns' && s.table === 'article_suggestion_facts',
    );
    expect(facts).toHaveLength(0);
  });

  it('v41 has no sql step mentioning article_suggestions', () => {
    const m = byVersion.get(41)!;
    const offending = m.steps.filter((s: any) => /article_suggestion/.test(sqlOf(s)));
    expect(offending).toHaveLength(0);
  });

  it('v41 does not create_table article_suggestions or article_suggestion_facts', () => {
    const m = byVersion.get(41)!;
    const creates = m.steps.filter(
      (s: any) =>
        s &&
        s.type === 'create_table' &&
        (s.schema?.name === 'article_suggestions' ||
          s.schema?.name === 'article_suggestion_facts'),
    );
    expect(creates).toHaveLength(0);
  });

  it('v41 additively adds only scored_at to article_suggestions', () => {
    const m = byVersion.get(41)!;
    const addStep = m.steps.find(
      (s: any) => s && s.type === 'add_columns' && s.table === 'article_suggestions',
    );
    expect(addStep).toBeDefined();
    const colNames = addStep.columns.map((c: any) => c.name);
    expect(colNames).toEqual(['scored_at']);
    expect(!!addStep.columns[0].isOptional).toBe(true);
  });
});

// ── P7b: CONVERGENCE — the migration chain reproduces schema.ts exactly ──────
//
// Reconstruct each table's column set purely from the migration steps
// (last create_table for the table ∪ every later add_columns for it) and assert
// set-equality (name + isOptional + isIndexed) with lib/database/schema.ts.
//
// This protects the critical invariant behind the P7b rewrite: every possible
// device start version (≤v33, v34-36, old-destructive-v37..v40, v41+) must end
// with the IDENTICAL column set, and NO path may add the same column twice — a
// duplicate ALTER would throw and brick DB setup. The additivity check below
// (no add_columns re-adds an existing column after the last create) is exactly
// that invariant.
describe('migration → schema convergence', () => {
  type ColSig = { name: string; isOptional: boolean; isIndexed: boolean };

  const norm = (c: any): ColSig => ({
    name: c.name,
    isOptional: !!c.isOptional,
    isIndexed: !!c.isIndexed,
  });

  const sigKey = (c: ColSig) => `${c.name}|${c.isOptional}|${c.isIndexed}`;

  // Walk the whole sorted chain: a create_table for `table` RESETS the working
  // column set (models the historical drop→recreate); an add_columns for
  // `table` merges in. Returns the converged set + any duplicate names an
  // add_columns tried to introduce after the last create (invariant violation).
  function reconstruct(table: string): { cols: ColSig[]; duplicates: string[] } {
    const cols = new Map<string, ColSig>();
    const duplicates: string[] = [];
    for (const m of migList) {
      for (const step of m.steps) {
        if (!step) continue;
        if (step.type === 'create_table' && step.schema?.name === table) {
          cols.clear();
          for (const c of step.schema.columnArray) {
            cols.set(c.name, norm(c));
          }
        } else if (step.type === 'add_columns' && step.table === table) {
          for (const c of step.columns) {
            if (cols.has(c.name)) duplicates.push(c.name);
            cols.set(c.name, norm(c));
          }
        }
      }
    }
    return { cols: [...cols.values()], duplicates };
  }

  function schemaColsOf(table: string): ColSig[] {
    const t = (schema as any).tables[table];
    expect(t).toBeDefined();
    return t.columnArray.map(norm);
  }

  it('article_suggestions: chain reconstruction set-equals schema.ts', () => {
    const { cols, duplicates } = reconstruct('article_suggestions');
    // Critical invariant: no column is ALTER-added twice on the current chain.
    expect(duplicates).toEqual([]);
    const fromChain = new Set(cols.map(sigKey));
    const fromSchema = new Set(schemaColsOf('article_suggestions').map(sigKey));
    expect(fromChain).toEqual(fromSchema);
  });

  it('article_suggestion_facts: chain reconstruction set-equals schema.ts', () => {
    const { cols, duplicates } = reconstruct('article_suggestion_facts');
    expect(duplicates).toEqual([]);
    const fromChain = new Set(cols.map(sigKey));
    const fromSchema = new Set(schemaColsOf('article_suggestion_facts').map(sigKey));
    expect(fromChain).toEqual(fromSchema);
  });
});
