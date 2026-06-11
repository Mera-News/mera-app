// ArticleSuggestion model unit tests
// The model has no custom writer methods — all behaviour lives in service layer.
// Tests cover: static table name, static associations, and field accessibility.

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
      prepareUpdate(fn?: (r: any) => void) {
        fn?.(this);
        return this;
      }
      async batch(...ops: any[]) {
        return ops.flat();
      }
    },
  };
});

jest.mock('@nozbe/watermelondb/decorators', () => ({
  field: () => (_target: any, _key: string) => {},
  date: () => (_target: any, _key: string) => {},
  children: () => (_target: any, _key: string) => {},
}));

import ArticleSuggestion from '../ArticleSuggestion';

describe('ArticleSuggestion model', () => {
  describe('static config', () => {
    it('has the correct table name', () => {
      expect(ArticleSuggestion.table).toBe('article_suggestions');
    });

    it('declares a has_many association for article_suggestion_facts', () => {
      const assoc = ArticleSuggestion.associations.article_suggestion_facts;
      expect(assoc).toBeDefined();
      expect(assoc.type).toBe('has_many');
      expect((assoc as any).foreignKey).toBe('article_suggestion_id');
    });
  });

  describe('field assignment (via prepareUpdate pattern)', () => {
    it('allows direct field mutations used by service write operations', () => {
      const instance: any = new ArticleSuggestion();
      instance.relevance = 0.8;
      instance.reason = 'Test reason';
      instance.relevanceGenerationCompleted = true;
      instance.reasonGenerationCompleted = false;
      instance.clusterMembershipsJson = '[{"clusterId":"c1","confidence":0.9}]';
      instance.matchedTopicTextsJson = '["berlin"]';

      expect(instance.relevance).toBe(0.8);
      expect(instance.reason).toBe('Test reason');
      expect(instance.relevanceGenerationCompleted).toBe(true);
      expect(instance.reasonGenerationCompleted).toBe(false);
      expect(instance.clusterMembershipsJson).toBe('[{"clusterId":"c1","confidence":0.9}]');
      expect(instance.matchedTopicTextsJson).toBe('["berlin"]');
    });

    it('prepareUpdate applies mutations and returns self', () => {
      const instance: any = new ArticleSuggestion();
      instance.relevance = 0;
      const returned = instance.prepareUpdate((r: any) => {
        r.relevance = 0.5;
        r.reason = 'updated';
        r.relevanceGenerationCompleted = true;
        r.reasonGenerationCompleted = true;
      });
      expect(returned).toBe(instance);
      expect(instance.relevance).toBe(0.5);
      expect(instance.reason).toBe('updated');
    });

    it('prepareDestroyPermanently returns a destroy op', () => {
      const instance: any = new ArticleSuggestion();
      const op = instance.prepareDestroyPermanently();
      expect(op._type).toBe('destroyPermanently');
      expect(op.record).toBe(instance);
    });
  });
});
