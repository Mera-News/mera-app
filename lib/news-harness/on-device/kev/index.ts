// The RN-free core of "Kev decides, the built-in model writes" (D38-D41).
// Layers: decide (decision.ts), rules (rules.ts), explain (kev-context.ts), and
// the unsure path's chips (ask-choice.ts). The flows' specs live beside each flow.

export * from './decision';
export * from './rules';
export * from './kev-context';
export * from './ask-choice';
export * from './turn';
