import { reportSecrets } from './report-secrets';

// Hosts the app or client calls by design. A person's own hosts are never here: they exist only at runtime.
const FIXED_HOSTS = [
  'mera.news',
  'u.expo.dev',
  'exp.host',
  'sentry.io',
  'huggingface.co',
  'nras.attestation.nvidia.com',
  'prod.vault.nvidia.com',
  'connectivitycheck.gstatic.com',
  'captive.apple.com',
  'www.googleapis.com',
  'storage.googleapis.com',
  'apps.apple.com',
  'play.google.com',
];
const SUBDOMAIN_HOSTS = ['mera.news', 'sentry.io'];

// Userinfo and port go with the host; an IPv6 literal counts as a host too.
const URL_HOST = /https?:\/\/(?:[^\s/@"'<>]*@)?(\[[0-9a-f:.]+\]|[^\s/?#:"'<>[\]]+)(?::\d+)?/gi;
const PAIRING_LINK = /meraapp:\/\/pod-pair[^\s"'<>]*/gi;

let allowed: Set<string> | undefined;

function allowedHosts(): Set<string> {
  if (allowed) return allowed;
  // Literal process.env members: Metro only inlines these exact forms.
  const endpoints = [
    process.env.EXPO_PUBLIC_AUTH_ENDPOINT,
    process.env.EXPO_PUBLIC_GRAPHQL_SERVER_ENDPOINT,
    process.env.EXPO_PUBLIC_INFERENCE_ENDPOINT,
    process.env.EXPO_PUBLIC_SENTRY_DSN,
  ];
  const hosts = new Set(FIXED_HOSTS);
  for (const e of endpoints) {
    const m = typeof e === 'string' ? /^[a-z][a-z0-9+.-]*:\/\/(?:[^/@]*@)?([^/?#:]+)/i.exec(e) : null;
    if (m) hosts.add(m[1].toLowerCase());
  }
  return (allowed = hosts);
}

function isAllowed(host: string): boolean {
  const h = host.toLowerCase();
  return allowedHosts().has(h) || SUBDOMAIN_HOSTS.some((d) => h.endsWith(`.${d}`));
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export function scrubOwnServices(text: string): string {
  const { hosts, secrets } = reportSecrets();
  let out = text;
  for (const s of secrets) out = out.split(s).join('[key]');
  out = out.replace(PAIRING_LINK, '[pairing-link]');
  for (const h of hosts) out = out.replace(new RegExp(escape(h), 'gi'), '[own-host]');
  return out.replace(URL_HOST, (all, host: string) => (isAllowed(host) ? all : 'https://[host]'));
}

const MAX_DEPTH = 8;

/**
 * Returns the value scrubbed, copying only what changes: the caller's objects are never edited, since a
 * breadcrumb's data can be live app state. Anything nested deeper than the cap is replaced, never let through.
 */
export function scrubDeep<T>(value: T, depth = 0): T {
  if (typeof value === 'string') return scrubOwnServices(value) as T;
  if (value === null || typeof value !== 'object') return value;
  if (depth > MAX_DEPTH) return '[dropped]' as T;
  if (Array.isArray(value)) {
    const next = value.map((v) => scrubDeep(v, depth + 1));
    return (next.some((v, i) => v !== value[i]) ? next : value) as T;
  }
  let out: Record<string, unknown> | null = null;
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    const n = scrubDeep(v, depth + 1);
    if (n !== v) (out ??= { ...(value as Record<string, unknown>) })[k] = n;
  }
  return (out ?? value) as T;
}
