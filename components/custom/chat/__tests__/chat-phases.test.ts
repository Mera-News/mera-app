// The registry and its copy.
//
// EVERY ASSERTION HERE READS `en.json` OFF DISK, never through `t()`. The
// suite mocks i18n globally, so a `t()`-based copy test passes against a
// dictionary that does not contain the key at all. A file read cannot.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { leaksInternals } from '@/lib/mera-harness/core/prose';
import { CLOUD_PHASE_ORDER, DEVICE_PHASE_ORDER } from '@/lib/services/chat-phase';
import { CHAT_PHASES, CHAT_PHASE_IDS, chatPhaseDef, OPENING_PHASE_ID } from '../chat-phases';

const en = JSON.parse(
  readFileSync(join(__dirname, '../../../../lib/locales/en.json'), 'utf8'),
) as Record<string, unknown>;

function pool(phrasesKey: string): string[] {
  const value = phrasesKey.split('.').reduce<unknown>(
    (acc, part) => (acc && typeof acc === 'object' ? (acc as Record<string, unknown>)[part] : undefined),
    en,
  );
  expect(Array.isArray(value)).toBe(true);
  return value as string[];
}

const ALL_LINES = CHAT_PHASES.flatMap((p) => pool(p.phrasesKey));
const CLOUD_LINES = CLOUD_PHASE_ORDER.flatMap((id) => pool(chatPhaseDef(id).phrasesKey));
const DEVICE_LINES = DEVICE_PHASE_ORDER.flatMap((id) => pool(chatPhaseDef(id).phrasesKey));

describe('the registry', () => {
  it('covers every phase id, in both engine orders', () => {
    // This is what makes `chatPhaseDef`'s "unreachable" throw actually
    // unreachable, and a wrong-engine caption a red test rather than a
    // silently missing line.
    expect(CHAT_PHASES.map((p) => p.id)).toEqual([...CHAT_PHASE_IDS]);
  });

  it('names a distinct key per phase', () => {
    const keys = CHAT_PHASES.map((p) => p.phrasesKey);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('has an opening phase that is a real phase', () => {
    expect(CHAT_PHASE_IDS).toContain(OPENING_PHASE_ID);
  });

  it('throws on an id outside the union rather than rendering nothing', () => {
    expect(() => chatPhaseDef('nope' as never)).toThrow(/unknown phase/);
  });
});

describe('the English copy', () => {
  it('resolves every key to a pool of at least two non-empty sentences', () => {
    for (const { id, phrasesKey } of CHAT_PHASES) {
      const lines = pool(phrasesKey);
      expect(lines.length).toBeGreaterThanOrEqual(2);
      for (const line of lines) {
        expect(typeof line).toBe('string');
        expect(line.trim().length).toBeGreaterThan(0);
        // Every line stands alone, so the cycle never depends on reading them
        // in order and a reader who catches only one still learns something.
        expect(line.trim()).toMatch(/[.!?]$/);
        expect(`${id}: ${line}`).not.toMatch(/\{\{/);
      }
    }
  });

  it('carries no em or en dash', () => {
    for (const line of ALL_LINES) expect(line).not.toMatch(/[—–]/);
  });

  it('leaks no internals, by the shipped detector rather than a second regex', () => {
    for (const line of ALL_LINES) {
      expect(`${line} :: ${leaksInternals(line)}`).toBe(`${line} :: false`);
    }
  });

  it('claims nowhere that the model is verified or attested', () => {
    // The hot inference path never calls `verifyAttestation`, and `'verified'`
    // is unreachable today, so either word on screen is a false privacy claim.
    for (const line of ALL_LINES) {
      expect(line).not.toMatch(/\bverif/i);
      expect(line).not.toMatch(/\battest/i);
      expect(line).not.toMatch(/\benclave\b/i);
    }
  });
});

const OFF_DEVICE = /encrypt|secur|server|cloud|network|upload|internet|online/i;

describe('on-device honesty', () => {

  it('never puts encryption, a server or a network in a device line', () => {
    // On-device inference never leaves the phone. A line implying otherwise is
    // the same class of false claim the source-available privacy wave spent a
    // pass removing from 7 spots across 20 locales.
    const offenders = DEVICE_LINES.filter((l) => OFF_DEVICE.test(l));
    expect(offenders).toEqual([]);
  });

  it('keeps the OPENING pool engine-neutral, since `idle` renders it on device too', () => {
    // `preparing` is a cloud-ordered id, but the `idle` view falls back to it
    // on BOTH engines. The device check above only covers the three `device*`
    // pools, so without this a future edit to `chatPhases.preparing` could put
    // "encrypted" in front of an on-device user and fail nothing.
    for (const line of pool(chatPhaseDef(OPENING_PHASE_ID).phrasesKey)) {
      expect(`${OPENING_PHASE_ID}: ${line}`).not.toMatch(OFF_DEVICE);
    }
  });

  it('CONTROL: the same matcher does fire on the cloud lines', () => {
    // Without this, a typo in the pattern above turns the honesty test into a
    // test that nothing matches nothing, and it passes forever.
    expect(CLOUD_LINES.some((l) => OFF_DEVICE.test(l))).toBe(true);
  });
});
