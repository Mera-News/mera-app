// Request transforms a model needs and the base harness does not, named in harness.json
// `params.quirks`. Empty: both shipped Qwen harnesses send exactly what cloud-base sends.
export type Quirk = (body: Record<string, unknown>) => Record<string, unknown>;

export const QUIRKS: Record<string, Quirk> = {};
