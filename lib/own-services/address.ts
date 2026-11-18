export type ServiceAddress =
  | { ok: true; url: string; host: string }
  | { ok: false; reason: 'not-https' | 'userinfo' | 'invalid' };

// Parsed by hand: React Native's URL validates nothing, keeps case and never converts a host to punycode.
const SHAPE = /^([a-z][a-z0-9+.-]*):\/\/([^/?#]*)([^\s]*)$/i;
const HOST_PORT = /^([a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*)(?::(\d{1,5}))?$/i;

export function parseServiceAddress(input: string): ServiceAddress {
  const m = SHAPE.exec(input.trim());
  if (!m) return { ok: false, reason: 'invalid' };
  const scheme = m[1].toLowerCase();
  // http and every other scheme would send a key or a reading in the clear or to a non-web target.
  if (scheme === 'http') return { ok: false, reason: 'not-https' };
  if (scheme !== 'https') return { ok: false, reason: 'invalid' };
  if (m[2].includes('@')) return { ok: false, reason: 'userinfo' };
  // ASCII hosts only: a non-ASCII host is typed in its xn-- form, which also shows what it really is.
  const hp = HOST_PORT.exec(m[2]);
  if (!hp || (hp[2] !== undefined && Number(hp[2]) > 65535)) return { ok: false, reason: 'invalid' };
  const host = hp[1].toLowerCase();
  const port = hp[2] !== undefined ? `:${hp[2]}` : '';
  return { ok: true, url: `https://${host}${port}${m[3].replace(/\/$/, '')}`, host };
}
