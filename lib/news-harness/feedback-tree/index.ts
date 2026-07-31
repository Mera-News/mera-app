// Public surface of the pure feedback-tree module (RN-FREE).
export * from './types';
export { evaluateCondition } from './evaluate-condition';
export { categoryStem, isDiscriminatingCategory } from './category-specificity';
export { resolveLeafActions } from './resolve-leaf-actions';
export { resolveTopicLabel, type TopicLabelChoice } from './resolve-topic-label';
