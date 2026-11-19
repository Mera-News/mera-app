import { AppState } from 'react-native';
import { sha256 } from '@noble/hashes/sha2.js';

import logger from '@/lib/logger';

import { PodError, sendPass, status } from './pod-client';
import { podConfig, savePairing, type PodPairing, type WakeRecord } from './pod-state';

const DAY_MS = 24 * 60 * 60 * 1000;
// A pass lives 14 days; ask for the next one while the old one still works.
const REMINT_BEFORE_MS = 3 * DAY_MS;

let waitForForeground = false;

// By hand, not URL: React Native's URL is unreliable. Scheme and host, lower case, the default port
// dropped; anything with a name or password in it, or no scheme, is no origin at all.
function originOf(url: string): string | null {
  const m = /^(https?):\/\/([^/?#@\s]+)(?:[/?#].*)?$/i.exec(url.trim());
  if (!m) return null;
  const scheme = m[1].toLowerCase();
  const host = m[2].toLowerCase().replace(scheme === 'https' ? /:443$/ : /:80$/, '');
  return `${scheme}://${host}`;
}

/** True when the server's relay is this build's own auth host. */
export function sameAuthOrigin(relayOrigin: string, authEndpoint: string): boolean {
  const relay = originOf(relayOrigin);
  return relay !== null && relay === originOf(authEndpoint);
}

// base64url, no padding, of the first 16 bytes of sha256(token).
function tokenHash(token: string): string {
  const bytes = sha256(new TextEncoder().encode(token)).subarray(0, 16);
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

const keep = (cfg: PodPairing, wake: WakeRecord | undefined): Promise<void> => savePairing({ ...cfg, wake });

const refused = (cfg: PodPairing, waitMs: number, why: string): Promise<void> => {
  logger.warn(`wake-ups: no pass, ${why}`);
  return keep(cfg, { ...cfg.wake, refusedAt: Date.now(), waitMs });
};

/** 429 carries the wait in seconds; a missing or odd value counts as a day. */
const retryAfterMs = (header: string | null): number => {
  const s = Number(header);
  return Number.isFinite(s) && s > 0 ? s * 1000 : DAY_MS;
};

async function askForPass(token: string): Promise<{ status: number; data?: { capability: string; expiresAt: number }; retryAfter: string | null }> {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { authClient } = require('@/lib/auth-client') as typeof import('@/lib/auth-client');
  let retryAfter: string | null = null;
  const res = await authClient.$fetch<{ capability: string; expiresAt: number }>('/pod/ping-capability', {
    method: 'POST',
    body: { pushTokenHash: tokenHash(token) },
    onResponse: (ctx: { response: Response }) => {
      retryAfter = ctx.response.headers.get('x-retry-after');
    },
  });
  return { status: res.error ? res.error.status : 200, data: res.data ?? undefined, retryAfter };
}

/** Wake-ups are off: once the server confirms it holds no pass, forget the record. */
async function withdraw(cfg: PodPairing): Promise<void> {
  const seen = await status(cfg);
  if (seen.wakeups !== 'on') return keep(cfg, undefined);
  await sendPass(cfg, null);
}

async function run(): Promise<void> {
  const cfg = podConfig();
  if (!cfg || AppState.currentState !== 'active') return;
  const rec = cfg.wake;
  if (cfg.wakeups !== true) {
    if (rec) await withdraw(cfg);
    return;
  }
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const token = (require('@/lib/stores/user-store') as typeof import('@/lib/stores/user-store')).useUserStore.getState().userPersona?.expoPushToken;
  if (!token || waitForForeground) return;
  const now = Date.now();
  if (rec?.refusedAt !== undefined && now < rec.refusedAt + (rec.waitMs ?? DAY_MS)) return;

  const seen = await status(cfg);
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { AUTH_ENDPOINT } = require('@/lib/config/endpoints') as typeof import('@/lib/config/endpoints');
  if (!seen.wakeups || seen.wakeups === 'disabled' || !seen.relayOrigin || !sameAuthOrigin(seen.relayOrigin, AUTH_ENDPOINT)) return;
  const hash = tokenHash(token);
  const fresh = rec?.tokenHash === hash && rec.expiresAt !== undefined && rec.expiresAt * 1000 - now > REMINT_BEFORE_MS;
  if (fresh && seen.wakeups === 'on') return;
  // While a pass is still valid, a new one (the server dropped it, the push token changed, it runs out
  // soon) is asked for at most once a day, so a push token that keeps changing cannot loop.
  const stillValid = rec?.expiresAt !== undefined && rec.expiresAt * 1000 > now;
  if (stillValid && rec?.mintedAt !== undefined && now < rec.mintedAt + DAY_MS) return;

  const got = await askForPass(token);
  if (got.status === 401) {
    waitForForeground = true;
    const sub = AppState.addEventListener('change', (state) => {
      if (state !== 'active') return;
      waitForForeground = false;
      sub.remove();
    });
    return;
  }
  if (got.status === 429) return refused(cfg, retryAfterMs(got.retryAfter), 'rate limited');
  const pass = got.data;
  if (got.status !== 200 || typeof pass?.capability !== 'string' || typeof pass.expiresAt !== 'number') return refused(cfg, DAY_MS, `status ${got.status}`);
  try {
    await sendPass(cfg, { capability: pass.capability, expiresAt: pass.expiresAt });
  } catch (e) {
    return refused(cfg, DAY_MS, e instanceof PodError ? e.code : 'failed');
  }
  await keep(cfg, { expiresAt: pass.expiresAt, tokenHash: hash, mintedAt: now });
}

/** After a successful foreground sync with the server. Never throws; the next foreground sync is the retry. */
export async function mintWakePass(): Promise<void> {
  try {
    await run();
  } catch {
    logger.warn('wake-ups: could not reach a server');
  }
}

/** Wake-ups were just turned off: tell the server now, and keep asking at each foreground sync until it says off. */
export async function sendWakeupsOff(): Promise<void> {
  const cfg = podConfig();
  if (!cfg) return;
  try {
    await keep(cfg, { ...cfg.wake, offPending: true });
    await sendPass(cfg, null);
  } catch {
    logger.warn('wake-ups: the server was not told yet');
  }
}
