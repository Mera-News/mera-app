// §8 structural assertions for lib/database/schema.ts
// No WatermelonDB native runtime needed — appSchema/tableSchema are pure data builders.

import schema from '../schema';

// WatermelonDB appSchema stores tables as a Record<tableName, TableSchema>
// (not an array). Use Object.values() to iterate.
const tableList = Object.values(schema.tables) as Array<{
  name: string;
  columns: Record<string, { name: string; type: string; isIndexed?: boolean; isOptional?: boolean }>;
  columnArray: Array<{ name: string; type: string; isIndexed?: boolean; isOptional?: boolean }>;
}>;

describe('appSchema', () => {
  it('has a version property that is a positive integer', () => {
    expect(typeof schema.version).toBe('number');
    expect(schema.version).toBeGreaterThan(0);
    expect(Number.isInteger(schema.version)).toBe(true);
  });

  it('has a tables object (not an array)', () => {
    expect(typeof schema.tables).toBe('object');
    expect(schema.tables).not.toBeNull();
    expect(Array.isArray(schema.tables)).toBe(false);
    expect(tableList.length).toBeGreaterThan(0);
  });

  it('contains no duplicate table names (keys are unique by definition)', () => {
    const names = tableList.map((t) => t.name);
    const uniqueNames = new Set(names);
    expect(uniqueNames.size).toBe(names.length);
  });

  it('contains all expected tables', () => {
    const tableNames = new Set(Object.keys(schema.tables));
    const expectedTables = [
      'facts',
      'conversations',
      'messages',
      'article_suggestions',
      'article_suggestion_facts',
      'user_personas',
      'settings',
      'publication_visits',
      'scheduler_jobs',
      'inference_jobs',
    ];
    for (const name of expectedTables) {
      expect(tableNames.has(name)).toBe(true);
    }
  });

  it('contains no duplicate column names within any table', () => {
    for (const table of tableList) {
      const colNames = table.columnArray.map((c) => c.name);
      const unique = new Set(colNames);
      expect(unique.size).toBe(colNames.length);
    }
  });

  it('every column has a valid type', () => {
    const VALID_TYPES = new Set(['string', 'number', 'boolean']);
    for (const table of tableList) {
      for (const col of table.columnArray) {
        expect(VALID_TYPES.has(col.type)).toBe(true);
      }
    }
  });
});

describe('user_personas table', () => {
  const table = (schema.tables as any)['user_personas'];

  it('exists in schema', () => {
    expect(table).toBeDefined();
  });

  it('has required columns', () => {
    const colNames = new Set(table.columnArray.map((c: any) => c.name));
    expect(colNames.has('server_id')).toBe(true);
    expect(colNames.has('user_id')).toBe(true);
    expect(colNames.has('processing_mode')).toBe(true);
    expect(colNames.has('onboarding_stage')).toBe(true);
    expect(colNames.has('blocked_by_llm')).toBe(true);
    expect(colNames.has('notifications_enabled')).toBe(true);
    expect(colNames.has('llm_warning_count')).toBe(true);
    expect(colNames.has('created_at')).toBe(true);
    expect(colNames.has('updated_at')).toBe(true);
  });
});

describe('inference_jobs table', () => {
  const table = (schema.tables as any)['inference_jobs'];

  it('exists in schema', () => {
    expect(table).toBeDefined();
  });

  it('has required columns', () => {
    const colNames = new Set(table.columnArray.map((c: any) => c.name));
    expect(colNames.has('job_type')).toBe(true);
    expect(colNames.has('status')).toBe(true);
    expect(colNames.has('priority')).toBe(true);
    expect(colNames.has('payload_json')).toBe(true);
    expect(colNames.has('attempts')).toBe(true);
    expect(colNames.has('max_attempts')).toBe(true);
    expect(colNames.has('created_at')).toBe(true);
    expect(colNames.has('updated_at')).toBe(true);
  });

  it('indexes job_type, status, and priority', () => {
    const indexedCols = table.columnArray
      .filter((c: any) => c.isIndexed)
      .map((c: any) => c.name);
    expect(indexedCols).toContain('job_type');
    expect(indexedCols).toContain('status');
    expect(indexedCols).toContain('priority');
  });
});

describe('publication_visits table', () => {
  const table = (schema.tables as any)['publication_visits'];

  it('exists in schema', () => {
    expect(table).toBeDefined();
  });

  it('has required and snapshot columns', () => {
    const colNames = new Set(table.columnArray.map((c: any) => c.name));
    expect(colNames.has('publication_name')).toBe(true);
    expect(colNames.has('country_code')).toBe(true);
    expect(colNames.has('article_id')).toBe(true);
    expect(colNames.has('visited_at')).toBe(true);
    expect(colNames.has('title_en')).toBe(true);
    expect(colNames.has('title_original')).toBe(true);
    expect(colNames.has('language_code')).toBe(true);
    expect(colNames.has('image_url')).toBe(true);
    expect(colNames.has('pub_date')).toBe(true);
  });

  it('indexes publication_name, country_code, and visited_at', () => {
    const indexed = table.columnArray
      .filter((c: any) => c.isIndexed)
      .map((c: any) => c.name);
    expect(indexed).toContain('publication_name');
    expect(indexed).toContain('country_code');
    expect(indexed).toContain('visited_at');
  });
});

describe('scheduler_jobs table', () => {
  const table = (schema.tables as any)['scheduler_jobs'];

  it('exists in schema', () => {
    expect(table).toBeDefined();
  });

  it('has all required columns', () => {
    const colNames = new Set(table.columnArray.map((c: any) => c.name));
    expect(colNames.has('task_name')).toBe(true);
    expect(colNames.has('status')).toBe(true);
    expect(colNames.has('attempt')).toBe(true);
    expect(colNames.has('max_attempts')).toBe(true);
    expect(colNames.has('scheduled_at')).toBe(true);
    expect(colNames.has('started_at')).toBe(true);
    expect(colNames.has('completed_at')).toBe(true);
    expect(colNames.has('retry_at')).toBe(true);
  });
});

describe('article_suggestions table', () => {
  const table = (schema.tables as any)['article_suggestions'];

  it('exists in schema', () => {
    expect(table).toBeDefined();
  });

  it('has cluster_memberships_json (v32 renamed from cluster_ids_json)', () => {
    const colNames = new Set(table.columnArray.map((c: any) => c.name));
    expect(colNames.has('cluster_memberships_json')).toBe(true);
    expect(colNames.has('cluster_ids_json')).toBe(false);
  });

  it('has title_original column (added in v31)', () => {
    const colNames = new Set(table.columnArray.map((c: any) => c.name));
    expect(colNames.has('title_original')).toBe(true);
  });
});
