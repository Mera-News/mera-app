// Guards the harness registry (lib/harnesses): every folder is registered and mapped, every
// `extends` resolves without a cycle, no file is duplicated across folders, and the Qwen
// harnesses yield today's prompts byte for byte.
import { createHash } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { HARNESS_FILES, HARNESS_MAPPING, harnessFolderFor, loadHarness } from '@/lib/harnesses';
import { resolveSlots } from '@/lib/harnesses/slots';
import { QUIRKS } from '@/lib/harnesses/quirks';
import { APP_TOOL_FORMAT } from '@/lib/llm/text-tool-protocol';
import * as personaPrompts from '@/lib/news-harness/prompts/persona-prompts';
import * as prompts from '@/lib/news-harness/prompts/prompts';
import { buildRouterPrompt, factRemovedPrompt } from '@/lib/mera-harness';

const ROOT = path.join(__dirname, '../../../../lib/harnesses');
const BASES = ['cloud-base', 'device-base'];
const sha = (b: Buffer | string) => createHash('sha256').update(b).digest('hex');
const folders = () => fs.readdirSync(ROOT).filter((f) => fs.statSync(path.join(ROOT, f)).isDirectory());

describe('harness registry', () => {
  it('registers exactly the folders on disk, each with a harness.json', () => {
    expect(folders().sort()).toEqual(Object.keys(HARNESS_FILES).sort());
    for (const f of folders()) expect(fs.existsSync(path.join(ROOT, f, 'harness.json'))).toBe(true);
  });

  it('maps every entry to a folder, and every cloud implementation is mapped', () => {
    for (const folder of Object.values(HARNESS_MAPPING)) expect(HARNESS_FILES[folder]).toBeDefined();
    const cloudImpls = Object.keys(HARNESS_FILES).filter((f) => !BASES.includes(f) && loadHarness(f).chain[0] === 'cloud-base');
    for (const f of cloudImpls) expect(Object.values(HARNESS_MAPPING)).toContain(f);
    expect(harnessFolderFor('redpill', 'qwen/qwen3.8-27b')).toBe('qwen3.8-27b');
    expect(harnessFolderFor('near', 'Qwen/Qwen3.6-35B-A3B-FP8')).toBe('qwen3.6-35b-a3b');
  });

  it('resolves every extends chain to a base, base first', () => {
    for (const f of Object.keys(HARNESS_FILES)) {
      const h = loadHarness(f);
      expect(BASES).toContain(h.chain[0]);
      expect(h.chain[h.chain.length - 1]).toBe(f);
    }
    expect(loadHarness('qwen3.6-35b-a3b').params.thinking).toBe(false);
    expect(loadHarness('qwen3.8-27b').params.firstTokenDeadlineMs['chat-tools']).toBe(30_000);
    expect(loadHarness('qwen3.8-27b').params.firstTokenDeadlineMs.scoring).toBe(120_000);
  });

  it('refuses a cycle and an unknown base', () => {
    HARNESS_FILES['loop-a'] = { extends: 'loop-b', params: {} };
    HARNESS_FILES['loop-b'] = { extends: 'loop-a', params: {} };
    HARNESS_FILES['orphan'] = { extends: 'nowhere', params: {} };
    try {
      expect(() => loadHarness('loop-a')).toThrow(/cycle/);
      expect(() => loadHarness('orphan')).toThrow(/not found/);
    } finally {
      delete HARNESS_FILES['loop-a'];
      delete HARNESS_FILES['loop-b'];
      delete HARNESS_FILES['orphan'];
    }
  });

  it('holds no byte-identical file in two folders', () => {
    const seen = new Map<string, string>();
    for (const f of folders()) {
      for (const file of fs.readdirSync(path.join(ROOT, f), { recursive: true }) as string[]) {
        if (fs.statSync(path.join(ROOT, f, file)).isDirectory()) continue;
        const where = `${f}/${file}`;
        const h = sha(fs.readFileSync(path.join(ROOT, f, file)));
        expect([seen.get(h), where]).toEqual([undefined, where]);
        seen.set(h, where);
      }
    }
  });

  it('resolves every slot and names only registered quirks', () => {
    for (const f of Object.keys(HARNESS_FILES)) {
      const slots = resolveSlots(f);
      for (const v of Object.values(slots)) expect(v).toBeDefined();
      for (const q of loadHarness(f).params.quirks) expect(QUIRKS[q]).toBeDefined();
    }
  });

  it.each(['qwen3.8-27b', 'qwen3.6-35b-a3b'])('%s yields today\'s cloud prompts byte for byte', (folder) => {
    const slots = resolveSlots(folder);
    const today: Record<string, unknown> = {
      routerPrompt: buildRouterPrompt,
      factRemovedPrompt,
      personaStatic: personaPrompts.buildPersonaUpdateStaticPrompt,
      topicGen: personaPrompts.CLOUD_TOPIC_GENERATION_SYSTEM_PROMPT,
      topicCombo: personaPrompts.COMBO_PASS_TOPIC_SYSTEM_PROMPT,
      topicSanity: personaPrompts.TOPIC_SANITY_SYSTEM_PROMPT,
      relevance: prompts.CLOUD_RELEVANCE_SYSTEM_PROMPT,
      reason: prompts.CLOUD_REASON_SYSTEM_PROMPT,
      headlineRelevance: prompts.CLOUD_HEADLINE_RELEVANCE_SYSTEM_PROMPT,
      headlineReason: prompts.CLOUD_HEADLINE_REASON_SYSTEM_PROMPT,
    };
    expect(Object.keys(slots).sort()).toEqual(Object.keys(today).sort());
    for (const [slot, value] of Object.entries(today)) {
      if (typeof value === 'string') expect(sha(slots[slot] as string)).toBe(sha(value));
      else expect(slots[slot]).toBe(value);
    }
    expect(loadHarness(folder).params.toolFormat).toBe(APP_TOOL_FORMAT);
  });
});
