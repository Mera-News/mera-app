// ArticleSuggestionFact model unit tests
// The model is a pure join/link row with no custom writer methods.
// Tests cover: static table name, associations config, and field accessibility.

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
  immutableRelation: () => (_target: any, _key: string) => {},
}));

import ArticleSuggestionFact from '../ArticleSuggestionFact';

describe('ArticleSuggestionFact model', () => {
  describe('static config', () => {
    it('has the correct table name', () => {
      expect(ArticleSuggestionFact.table).toBe('article_suggestion_facts');
    });

    it('declares a belongs_to association for article_suggestions', () => {
      const assoc = ArticleSuggestionFact.associations.article_suggestions;
      expect(assoc).toBeDefined();
      expect(assoc.type).toBe('belongs_to');
      expect((assoc as any).key).toBe('article_suggestion_id');
    });

    it('declares a belongs_to association for facts', () => {
      const assoc = ArticleSuggestionFact.associations.facts;
      expect(assoc).toBeDefined();
      expect(assoc.type).toBe('belongs_to');
      expect((assoc as any).key).toBe('fact_id');
    });
  });

  describe('field assignment', () => {
    it('allows direct field mutations for articleSuggestionId and factId', () => {
      const instance: any = new (ArticleSuggestionFact as any)();
      instance.articleSuggestionId = 'sug-123';
      instance.factId = 'fact-456';
      expect(instance.articleSuggestionId).toBe('sug-123');
      expect(instance.factId).toBe('fact-456');
    });

    it('prepareDestroyPermanently returns a destroy op referencing self', () => {
      const instance: any = new (ArticleSuggestionFact as any)();
      const op = instance.prepareDestroyPermanently();
      expect(op._type).toBe('destroyPermanently');
      expect(op.record).toBe(instance);
    });
  });
});
