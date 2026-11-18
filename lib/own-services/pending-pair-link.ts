import { parseServiceAddress } from './address';

export type PairLink = { ok: true; baseUrl: string; host: string; code: string } | { ok: false };

const MAX_CODE = 32;
const LINK_TTL_MS = 10 * 60_000;
const SHAPE = /^meraapp:\/\/pod-pair\?([^#]*)$/i;

// Parsed by hand: React Native's URL does not read query strings reliably.
function param(query: string, name: string): string | null {
  for (const pair of query.split('&')) {
    const eq = pair.indexOf('=');
    if ((eq < 0 ? pair : pair.slice(0, eq)) !== name) continue;
    try {
      return decodeURIComponent(eq < 0 ? '' : pair.slice(eq + 1).replace(/\+/g, ' '));
    } catch {
      return null;
    }
  }
  return null;
}

export function parsePairLink(url: string): PairLink {
  const m = SHAPE.exec(url.trim());
  if (!m) return { ok: false };
  const u = param(m[1], 'u');
  const code = param(m[1], 'c')?.trim();
  if (!u || !code || code.length > MAX_CODE) return { ok: false };
  const addr = parseServiceAddress(u);
  if (!addr.ok) return { ok: false };
  return { ok: true, baseUrl: addr.url, host: addr.host, code };
}

// Memory only: a link carries a one-time code and is never stored.
let pending: { link: Extract<PairLink, { ok: true }>; at: number } | null = null;

export function setPendingPairLink(link: Extract<PairLink, { ok: true }>): void {
  pending = { link, at: Date.now() };
}

export function takePendingPairLink(): Extract<PairLink, { ok: true }> | null {
  const held = pending;
  pending = null;
  return held && Date.now() - held.at <= LINK_TTL_MS ? held.link : null;
}
