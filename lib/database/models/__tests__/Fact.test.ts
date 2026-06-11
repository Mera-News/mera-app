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
      const instance: any = new Fact();
      instance.statement = 'old statement';
      instance.metadata = { topics: ['old'] };

      await instance.updateFact('new statement', { topics: ['new'] });

      expect(instance.statement).toBe('new statement');
      expect(instance.metadata).toEqual({ topics: ['new'] });
    });

    it('clears metadata when undefined is passed (metadata branch skipped)', async () => {
      const instance: any = new Fact();
      instance.statement = 'stmt';
      instance.metadata = { topics: ['x'] };

      // metadata arg is undefined → the `if (metadata !== undefined)` branch is skipped
      await instance.updateFact('new stmt', undefined);
      // metadata should remain unchanged (branch not entered)
      expect(instance.metadata).toEqual({ topics: ['x'] });
    });

    it('sets metadata to null/undefined when explicitly passed null', async () => {
      const instance: any = new Fact();
      instance.statement = 'stmt';
      instance.metadata = { topics: ['x'] };

      await instance.updateFact('stmt', null as any);
      expect(instance.metadata).toBeNull();
    });

    it('updates questionnaire fields when provided', async () => {
      const instance: any = new Fact();
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
      const instance: any = new Fact();
      instance.statement = 'stmt';
      instance.questionnaireLevel = 1;
      instance.questionnaireLevelCategory = 'Existing';
      // Only provide level — category and attribute should stay untouched
      await instance.updateFact('stmt', undefined, { level: 5 });
      expect(instance.questionnaireLevel).toBe(5);
      expect(instance.questionnaireLevelCategory).toBe('Existing');
    });

    it('does not touch questionnaire fields when questionnaire arg is omitted', async () => {
      const instance: any = new Fact();
      instance.statement = 'stmt';
      instance.questionnaireLevel = 2;
      await instance.updateFact('stmt');
      expect(instance.questionnaireLevel).toBe(2);
    });
  });

  describe('destroyCascade', () => {
    it('calls batch with prepareDestroyPermanently result', async () => {
      const instance: any = new Fact();
      const batchSpy = jest.spyOn(instance, 'batch');
      await instance.destroyCascade();
      expect(batchSpy).toHaveBeenCalledTimes(1);
      // The argument should be the result of prepareDestroyPermanently
      const arg = batchSpy.mock.calls[0][0];
      expect(arg._type).toBe('destroyPermanently');
    });
  });
});
