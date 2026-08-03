// Fact model unit tests
// Tests cover: static table config, static associations absence, the updateFact
// writer, and the destroyCascade writer — all without a live DB.

jest.mock('@nozbe/watermelondb', () => {
  return {
    Model: class Model {
      async update(fn?: (r: any) => void) {
        fn?.(this);
        return this;
      }
      prepareDestroyPermanently() {
        return { _type: 'destroyPermanently', record: this };
      }
      async batch(...ops: any[]) {
        return ops.flat();
      }
    },
    Q: { where: (column: string, value: unknown) => ({ column, value }) },
  };
});

jest.mock('@nozbe/watermelondb/decorators', () => ({
  text: () => (_target: any, _key: string) => {},
  json: () => (_target: any, _key: string) => {},
  date: () => (_target: any, _key: string) => {},
  field: () => (_target: any, _key: string) => {},
  writer: (_target: any, _key: string, descriptor: PropertyDescriptor) => descriptor,
}));

import Fact from '../Fact';

describe('Fact model', () => {
  describe('static config', () => {
    it('has the correct table name', () => {
      expect(Fact.table).toBe('facts');
    });
  });

  describe('updateFact', () => {
    it('updates statement and metadata when both provided', async () => {
      const instance: any = new (Fact as any)();
      instance.statement = 'old statement';
      instance.metadata = { topics: ['old'] };

      await instance.updateFact('new statement', { topics: ['new'] });

      expect(instance.statement).toBe('new statement');
      expect(instance.metadata).toEqual({ topics: ['new'] });
    });

    it('clears metadata when undefined is passed (metadata branch skipped)', async () => {
      const instance: any = new (Fact as any)();
      instance.statement = 'stmt';
      instance.metadata = { topics: ['x'] };

      // metadata arg is undefined → the `if (metadata !== undefined)` branch is skipped
      await instance.updateFact('new stmt', undefined);
      // metadata should remain unchanged (branch not entered)
      expect(instance.metadata).toEqual({ topics: ['x'] });
    });

    it('sets metadata to null/undefined when explicitly passed null', async () => {
      const instance: any = new (Fact as any)();
      instance.statement = 'stmt';
      instance.metadata = { topics: ['x'] };

      await instance.updateFact('stmt', null as any);
      expect(instance.metadata).toBeNull();
    });

    it('updates questionnaire fields when provided', async () => {
      const instance: any = new (Fact as any)();
      instance.statement = 'stmt';
      await instance.updateFact('stmt', undefined, {
        level: 3,
        levelCategory: 'Core',
        attribute: 'location: city',
      });
      expect(instance.questionnaireLevel).toBe(3);
      expect(instance.questionnaireLevelCategory).toBe('Core');
      expect(instance.questionnaireAttribute).toBe('location: city');
    });

    it('only sets questionnaire subfields that are provided', async () => {
      const instance: any = new (Fact as any)();
      instance.statement = 'stmt';
      instance.questionnaireLevel = 1;
      instance.questionnaireLevelCategory = 'Existing';
      // Only provide level — category and attribute should stay untouched
      await instance.updateFact('stmt', undefined, { level: 5 });
      expect(instance.questionnaireLevel).toBe(5);
      expect(instance.questionnaireLevelCategory).toBe('Existing');
    });

    it('does not touch questionnaire fields when questionnaire arg is omitted', async () => {
      const instance: any = new (Fact as any)();
      instance.statement = 'stmt';
      instance.questionnaireLevel = 2;
      await instance.updateFact('stmt');
      expect(instance.questionnaireLevel).toBe(2);
    });
  });

  describe('destroyCascade', () => {
    /** A Fact instance wired to a fake `topics` collection. */
    function makeFact(id: string, topicRows: any[]) {
      const instance: any = new (Fact as any)();
      instance.id = id;
      const query = jest.fn(() => ({ fetch: jest.fn(async () => topicRows) }));
      instance.collections = { get: jest.fn(() => ({ query })) };
      return { instance, query };
    }

    function topicRow(id: string) {
      return { id, prepareDestroyPermanently: jest.fn(() => ({ _type: 'destroyPermanently', id })) };
    }

    it('destroys the fact AND every topic that belongs to it', async () => {
      // The cascade must be real: an orphaned ACTIVE topic keeps fetching feed
      // content for a deleted interest, and the Dashboard then drops every
      // suggestion it claims (ownership needs the fact snapshot) — measured as
      // a permanently empty Dashboard on a device with 74 orphans.
      const { instance, query } = makeFact('fact-1', [topicRow('t1'), topicRow('t2')]);
      const batchSpy = jest.spyOn(instance, 'batch');

      await instance.destroyCascade();

      expect(instance.collections.get).toHaveBeenCalledWith('topics');
      expect(query).toHaveBeenCalledWith({ column: 'fact_id', value: 'fact-1' });
      expect(batchSpy).toHaveBeenCalledTimes(1);
      const ops = batchSpy.mock.calls[0] as any[];
      expect(ops).toHaveLength(3); // the fact + both topics, one batch
      expect(ops[0]._type).toBe('destroyPermanently');
      expect(ops.slice(1).map((o: any) => o.id)).toEqual(['t1', 't2']);
    });

    it('still destroys the fact when it owns no topics', async () => {
      const { instance } = makeFact('fact-2', []);
      const batchSpy = jest.spyOn(instance, 'batch');

      await instance.destroyCascade();

      const ops = batchSpy.mock.calls[0] as any[];
      expect(ops).toHaveLength(1);
      expect(ops[0]._type).toBe('destroyPermanently');
    });
  });
});
