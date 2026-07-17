// scoring-engine — deterministic math relevance engine (Wave 7a).
//
// Pure, RN-free. Consumed by the scoring orchestrators (later wave) and by the
// offline eval (eval/). Exports the persona snapshot types + normalizers, the
// geo resolver, and computeRelevance().

export * from './persona-context';
export * from './geo';
export * from './relevance';
export * from './judge';
export * from './judge-calls';
export * from './run-stage';
export * from './retrieval-profile';
