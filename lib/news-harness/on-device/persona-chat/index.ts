// On-device persona chat (D27, D31): the reply plus facts to offer, facts to
// remove and a yes or no to a waiting change, mapped by the app to
// PersonaUpdateAgent's executors. Warnings, calibration and config changes stay
// cloud-only. RN-free, so the harness builds the same prompt.
export * from './schema';
export * from './prompt';
export * from './parse';
