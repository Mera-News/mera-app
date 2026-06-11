// SyncedSuggestionId model — test static metadata only.
// Note: This table was dropped in the v24 migration but the model file still exists.

jest.mock('@nozbe/watermelondb', () => {
  class Model {
    static table = '';
  }
  return { Model };
});

jest.mock('@nozbe/watermelondb/decorators', () => ({
  field: () => () => {},
}));

import SyncedSuggestionId from '../SyncedSuggestionId';

describe('SyncedSuggestionId model', () => {
  it('has the correct static table name', () => {
    expect(SyncedSuggestionId.table).toBe('synced_suggestion_ids');
  });

  it('is importable without errors', () => {
    expect(SyncedSuggestionId).toBeDefined();
    expect(typeof SyncedSuggestionId).toBe('function');
  });

  it('can be instantiated', () => {
    const s = new SyncedSuggestionId();
    expect(s).toBeDefined();
    expect(s instanceof SyncedSuggestionId).toBe(true);
  });
});
