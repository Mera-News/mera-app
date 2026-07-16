// harness-local — file-backed PersonaStorePort implementation. Loads a JSON
// fixture of Facts, mutates an in-memory working copy via updateFactMetadata,
// and (optionally, via --write-back) persists that working copy back to disk.

import * as fs from 'node:fs';

import type { PersonaStorePort } from '@/lib/news-harness/core/ports';
import type { Fact } from '@/lib/news-harness/core/types';

const FACT_KEY_ORDER: (keyof Fact)[] = [
  'id',
  'statement',
  'metadata',
  'questionnaireLevel',
  'questionnaireLevelCategory',
  'questionnaireAttribute',
  'createdAt',
  'updatedAt',
];

function sortFactKeys(fact: Fact): Fact {
  const ordered: Partial<Fact> = {};
  for (const key of FACT_KEY_ORDER) {
    const value = fact[key];
    if (value !== undefined) {
      (ordered as Record<string, unknown>)[key] = value;
    }
  }
  return ordered as Fact;
}

export function createFilePersonaStore(
  filePath: string,
): PersonaStorePort & { snapshot(): { facts: Fact[] }; writeBack(): Promise<void> } {
  if (!fs.existsSync(filePath)) {
    throw new Error(
      `harness-local: persona file not found at ${filePath}. The harness scripts ` +
        'auto-bootstrap .local-test-data/persona.json from fixtures/persona.example.json ' +
        'on first run — if you passed a custom --facts path, copy the fixture there ' +
        '(and edit it to taste) first.',
    );
  }

  const raw = fs.readFileSync(filePath, 'utf-8');
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `harness-local: failed to parse persona file at ${filePath}: ${(err as Error).message}`,
    );
  }
  if (
    !parsed ||
    typeof parsed !== 'object' ||
    !Array.isArray((parsed as { facts?: unknown }).facts)
  ) {
    throw new Error(
      `harness-local: persona file at ${filePath} must be shaped { "facts": Fact[] }`,
    );
  }

  // In-memory working copy. Only writeBack() touches disk, so a scripted run
  // can be replayed/reasoned about without accidentally mutating the fixture.
  const facts: Fact[] = (parsed as { facts: Fact[] }).facts.map((f) => ({ ...f }));

  return {
    async getFacts() {
      return facts.map((f) => ({ ...f }));
    },

    async updateFactMetadata(id, metadata) {
      const fact = facts.find((f) => f.id === id);
      if (!fact) {
        throw new Error(`harness-local: updateFactMetadata called for unknown fact id "${id}"`);
      }
      // Mirrors lib/database/services/fact-service.ts's updateFact →
      // lib/database/models/Fact.ts's `@writer updateFact`: when a metadata
      // object is passed, the fact's ENTIRE metadata field is replaced with it
      // (`fact.metadata = metadata`) — it is not a per-key merge. The harness
      // callers (generateTopicsForFactsBatch) always pass the complete,
      // already-merged metadata object for the key(s) they own (topics /
      // topicGenError), so this stays behaviourally identical to production.
      fact.metadata = metadata;
      fact.updatedAt = new Date().toISOString();
    },

    snapshot() {
      return { facts: facts.map((f) => ({ ...f })) };
    },

    async writeBack() {
      const stable = { facts: facts.map(sortFactKeys) };
      fs.writeFileSync(filePath, JSON.stringify(stable, null, 2) + '\n', 'utf-8');
    },
  };
}
