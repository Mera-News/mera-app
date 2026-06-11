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

  it('updateValue calls this.update and mutates the value field', async () => {
    const instance: any = new Setting();
    // Pre-seed a field so the callback can read it
    instance.value = 'old_value';
    // The writer decorator is stripped to a passthrough in our mock
    await instance.updateValue('new_value');
    expect(instance.value).toBe('new_value');
  });

  it('updateValue does not mutate other fields', async () => {
    const instance: any = new Setting();
    instance.key = 'my_key';
    instance.value = 'old';
    await instance.updateValue('new');
    expect(instance.key).toBe('my_key');
  });
});
