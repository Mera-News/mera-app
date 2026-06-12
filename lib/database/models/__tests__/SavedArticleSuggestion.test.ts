// SavedArticleSuggestion model unit tests
// The model has no custom writer methods — all behaviour lives in the service
// layer. Tests cover: static table name and field accessibility.

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
    },
  };
});

jest.mock('@nozbe/watermelondb/decorators', () => ({
  field: () => (_target: any, _key: string) => {},
  date: () => (_target: any, _key: string) => {},
}));

import SavedArticleSuggestion from '../SavedArticleSuggestion';

describe('SavedArticleSuggestion model', () => {
  describe('static config', () => {
    it('has the correct table name', () => {
      expect(SavedArticleSuggestion.table).toBe('saved_article_suggestions');
    });
  });

  describe('field assignment', () => {
    it('allows direct field mutations used by service write operations', () => {
      const instance: any = new (SavedArticleSuggestion as any)();
      instance.articleId = 'a1';
      instance.relevance = 0.8;
      instance.reason = 'Test reason';
      instance.relevanceGenerationCompleted = true;
      instance.reasonGenerationCompleted = false;
      instance.clusterMembershipsJson = '[{"clusterId":"c1","confidence":0.9}]';
      instance.matchedTopicTextsJson = '["berlin"]';
      instance.savedAt = new Date(1700000000000);

      expect(instance.articleId).toBe('a1');
      expect(instance.relevance).toBe(0.8);
      expect(instance.reason).toBe('Test reason');
      expect(instance.relevanceGenerationCompleted).toBe(true);
      expect(instance.reasonGenerationCompleted).toBe(false);
      expect(instance.clusterMembershipsJson).toBe('[{"clusterId":"c1","confidence":0.9}]');
      expect(instance.matchedTopicTextsJson).toBe('["berlin"]');
      expect(instance.savedAt).toBeInstanceOf(Date);
    });

    it('prepareUpdate applies mutations and returns self', () => {
      const instance: any = new (SavedArticleSuggestion as any)();
      const returned = instance.prepareUpdate((r: any) => {
        r.relevance = 0.5;
        r.savedAt = new Date(1700000000001);
      });
      expect(returned).toBe(instance);
      expect(instance.relevance).toBe(0.5);
    });

    it('prepareDestroyPermanently returns a destroy op', () => {
      const instance: any = new (SavedArticleSuggestion as any)();
      const op = instance.prepareDestroyPermanently();
      expect(op._type).toBe('destroyPermanently');
      expect(op.record).toBe(instance);
    });
  });
});
