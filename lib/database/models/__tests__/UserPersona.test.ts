// UserPersona model — test static metadata only (no writer methods).

jest.mock('@nozbe/watermelondb', () => {
  class Model {
    static table = '';
  }
  return { Model };
});

jest.mock('@nozbe/watermelondb/decorators', () => ({
  field: () => () => {},
  json: () => () => {},
  date: () => () => {},
}));

import UserPersona from '../UserPersona';

describe('UserPersona model', () => {
  it('has the correct static table name', () => {
    expect(UserPersona.table).toBe('user_personas');
  });

  it('is importable without errors', () => {
    expect(UserPersona).toBeDefined();
    expect(typeof UserPersona).toBe('function');
  });

  it('can be instantiated', () => {
    const p = new UserPersona();
    expect(p).toBeDefined();
    expect(p instanceof UserPersona).toBe(true);
  });
});
