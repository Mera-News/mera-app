import { setupServer } from 'msw/node';
import { defaultHandlers } from '../mock-backend/handlers';

export const server = setupServer(...defaultHandlers);

// Filled by the integration setup's onUnhandledRequest; checked after each test.
export const unhandled: string[] = [];
