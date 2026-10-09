import type { RequestHandler } from 'msw';

export const authHandlers: RequestHandler[] = [];
export function resetAuthState(): void {}
