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
