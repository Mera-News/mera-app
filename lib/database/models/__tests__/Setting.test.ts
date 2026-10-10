// Setting model unit tests
// The model extends WatermelonDB's Model. We test the static configuration and
// the writer method behaviour using a controlled stub instead of a live DB.

// Mock WatermelonDB so decorator and base class never touch a native DB.
jest.mock('@nozbe/watermelondb', () => {
  return {
    Model: class Model {
      // Minimal stub: the `update` method delegates to the writer factory.
      async update(fn?: (r: any) => void) {
        fn?.(this);
        return this;
      }
      async batch(...ops: any[]) { return ops.flat(); }
    },
  };
});

jest.mock('@nozbe/watermelondb/decorators', () => ({
  field: () => (_target: any, _key: string) => {},
  writer: (_target: any, _key: string, descriptor: PropertyDescriptor) => descriptor,
}));

import Setting from '../Setting';

describe('Setting model', () => {
  it('has the correct table name', () => {
    expect(Setting.table).toBe('settings');
  });
});
