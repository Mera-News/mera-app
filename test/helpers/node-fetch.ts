// Maps `expo/fetch` in the integration project. Bound late so MSW's patch of
// globalThis.fetch (applied in beforeAll) is what runs.
export const fetch: typeof globalThis.fetch = (...a) => globalThis.fetch(...a);
