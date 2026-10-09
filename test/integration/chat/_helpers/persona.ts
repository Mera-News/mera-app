// Seeding through the app's own services, never hand-written rows.
import { addFact, getFacts } from '@/lib/database/services/fact-service';
import { setSetting } from '@/lib/database/services/setting-service';
import { ProcessingMode } from '@/lib/generated/graphql-types';
import { useMeraProtocolStore } from '@/lib/stores/mera-protocol-store';
import type { Fact } from '@/lib/mera-protocol-toolkit/types';

export interface SeedFact {
  statement: string;
  /** Questionnaire attribute key, e.g. `location: neighborhood/area, city, and country (preserve specifics)`. */
  attribute?: string;
}

/** Adds facts in order (each `addFact`, so `created_at` follows the order) and returns them as stored. */
export async function seedFacts(facts: (string | SeedFact)[]): Promise<Fact[]> {
  for (const f of facts) {
    const { statement, attribute } = typeof f === 'string' ? { statement: f, attribute: undefined } : f;
    await addFact(statement, undefined, attribute ? { attribute } : undefined);
  }
  return getFacts();
}

/** Sets the processing mode the way the settings screen does, and waits for the persisted row
 *  (the store's own setter writes it fire-and-forget). */
export async function setProcessingMode(mode: 'cloud' | 'on-device'): Promise<void> {
  const value = mode === 'cloud' ? ProcessingMode.Cloud : ProcessingMode.OnDevice;
  useMeraProtocolStore.getState().setProcessingMode(value);
  await setSetting('mera_processing_mode', value);
}

/** "Web search in chat" on or off: the store's setter plus the persisted row it writes. */
export async function setWebSearchInChat(on: boolean): Promise<void> {
  useMeraProtocolStore.getState().setWebSearchInChat(on);
  await setSetting('mera_web_search_in_chat', on ? 'true' : 'false');
}
