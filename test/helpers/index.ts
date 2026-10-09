export { server } from './msw';
export { http, graphql, HttpResponse, delay } from 'msw';
export { useFakeClock, advanceUntilSettled } from './clock';
export { setAppState } from './app-state';
export { failSecureStore, secureStoreDump } from './storage';
export { initI18nEn } from './i18n';
export { setScenario, resetScenario, getScenario } from '../mock-backend/scenario';

export async function resetDatabase(): Promise<void> {
  const database = require('@/lib/database').default;
  await database.write(() => database.unsafeResetDatabase());
}
