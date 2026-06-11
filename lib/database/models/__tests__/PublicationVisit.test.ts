// PublicationVisit model — test static metadata only (no writer methods).

jest.mock('@nozbe/watermelondb', () => {
  class Model {
    static table = '';
  }
  return { Model };
});

jest.mock('@nozbe/watermelondb/decorators', () => ({
  field: () => () => {},
  date: () => () => {},
}));

import PublicationVisit from '../PublicationVisit';

describe('PublicationVisit model', () => {
  it('has the correct static table name', () => {
    expect(PublicationVisit.table).toBe('publication_visits');
  });

  it('is importable without errors', () => {
    expect(PublicationVisit).toBeDefined();
    expect(typeof PublicationVisit).toBe('function');
  });

  it('can be instantiated', () => {
    const v = new (PublicationVisit as any)();
    expect(v).toBeDefined();
    expect(v instanceof PublicationVisit).toBe(true);
  });
});
