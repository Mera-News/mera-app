// The in-memory DB reset. Its own module so jest.setup.integration.js can require it from a hook
// without loading the helpers index (which pulls @testing-library/react-native: loaded inside a
// hook, that registers its own hooks there and fails the test).
export async function resetDatabase(): Promise<void> {
  const database = require('@/lib/database').default;
  await database.write(() => database.unsafeResetDatabase());
}
