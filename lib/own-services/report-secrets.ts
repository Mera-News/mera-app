type Kind = 'ownAi' | 'ownNews' | 'pod';
type Secrets = { hosts: string[]; secrets: string[] };

// Zero imports so the error reporter can load this without pulling in a store, an endpoint or the client.
const held: Partial<Record<Kind, Secrets>> = {};

export function setReportSecrets(kind: Kind, value: Secrets | null): void {
  if (value) held[kind] = value;
  else delete held[kind];
}

export function reportSecrets(): Secrets {
  const all = Object.values(held);
  const hosts = new Set(all.flatMap((s) => s.hosts.map((h) => h.toLowerCase())));
  // Under 8 characters a value could blank ordinary text.
  const secrets = new Set(all.flatMap((s) => s.secrets).filter((s) => s.length >= 8));
  return { hosts: [...hosts], secrets: [...secrets] };
}
