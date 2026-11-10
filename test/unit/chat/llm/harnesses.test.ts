// Guards the harness registry (lib/harnesses): every folder is registered and mapped, every
// `extends` resolves without a cycle, no file is duplicated across folders, implementations hold
// only params and real overrides, slots.generated.ts is current, and the Qwen harnesses yield
// today's prompts byte for byte (prompt-hashes.test.ts pins every built prompt).
import { createHash } from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { HARNESS_FILES, HARNESS_MAPPING, harnessFolderFor, loadHarness } from '@/lib/harnesses';
import { generateSlotsModuleText, slotsFileFor } from '@/lib/harnesses/generate';
import { resolveSlots } from '@/lib/harnesses/slots';
import { CLOUD_BASE_SLOTS, DEVICE_BASE_SLOTS } from '@/lib/harnesses/slots.generated';
import { QUIRKS } from '@/lib/harnesses/quirks';
import { render, parseTemplate } from '@/lib/harnesses/template';
import { APP_TOOL_FORMAT } from '@/lib/llm/text-tool-protocol';
import * as prompts from '@/lib/news-harness/prompts/prompts';
import { NOTE_SYSTEM } from '@/lib/news-harness/on-device/notes/prompt';
import { firstDifference } from '@/lib/mera-harness/skills/generate';

const ROOT = path.join(__dirname, '../../../../lib/harnesses');
const BASES = ['cloud-base', 'device-base'];
const sha = (b: Buffer | string) => createHash('sha256').update(b).digest('hex');
const folders = () => fs.readdirSync(ROOT).filter((f) => fs.statSync(path.join(ROOT, f)).isDirectory());
const filesIn = (dir: string, rel = ''): string[] =>
  fs.readdirSync(path.join(dir, rel), { withFileTypes: true }).flatMap((e) => {
    const r = rel ? `${rel}/${e.name}` : e.name;
    return e.isDirectory() ? filesIn(dir, r) : [r];
  });
const copyTree = (from: string, to: string) => fs.cpSync(from, to, { recursive: true });

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
      for (const file of filesIn(path.join(ROOT, f))) {
        const where = `${f}/${file}`;
        const h = sha(fs.readFileSync(path.join(ROOT, f, file)));
        const other = seen.get(h);
        if (other && other.split('/')[0] !== f) expect([other, where]).toEqual([undefined, where]);
        seen.set(h, where);
      }
    }
  });

  it('keeps only harness.json and slot overrides in an implementation folder', () => {
    for (const f of Object.keys(HARNESS_FILES).filter((x) => !BASES.includes(x))) {
      const extra = filesIn(path.join(ROOT, f)).filter((file) => file !== 'harness.json' && !file.endsWith('.md'));
      expect([f, extra]).toEqual([f, []]);
    }
  });

  it('names only registered quirks, and every folder resolves its slots', () => {
    for (const f of Object.keys(HARNESS_FILES)) {
      for (const q of loadHarness(f).params.quirks) expect(QUIRKS[q]).toBeDefined();
      expect(Object.keys(resolveSlots(f)).length).toBeGreaterThan(5);
    }
  });

  it.each(['qwen3.8-27b', 'qwen3.6-35b-a3b'])('%s yields today\'s cloud prompts byte for byte', (folder) => {
    const slots = resolveSlots(folder);
    expect(slots).toEqual(CLOUD_BASE_SLOTS);
    expect(sha(slots['scoring/cloud-relevance-system-prompt'])).toBe(sha(prompts.CLOUD_RELEVANCE_SYSTEM_PROMPT));
    expect(sha(slots['scoring/cloud-reason-system-prompt'])).toBe(sha(prompts.CLOUD_REASON_SYSTEM_PROMPT));
    expect(sha(slots['topic-gen/cloud-topic-generation-system-prompt'])).toBe(sha(prompts.CLOUD_TOPIC_GENERATION_SYSTEM_PROMPT));
    expect(loadHarness(folder).params.toolFormat).toBe(APP_TOOL_FORMAT);
  });

  it('afm yields today\'s on-device prompts byte for byte', () => {
    const slots = resolveSlots('afm');
    expect(slots).toEqual(DEVICE_BASE_SLOTS);
    expect(slots['notes/note-system']).toBe(NOTE_SYSTEM);
  });
});

describe('slots.generated.ts', () => {
  it('is what harness:generate produces from the current .md files', () => {
    const diff = firstDifference(fs.readFileSync(slotsFileFor(ROOT), 'utf8'), generateSlotsModuleText(ROOT));
    expect(diff === null ? null : `slots.generated.ts is stale. Run: npm run harness:generate\n  first difference at ${diff}`).toBeNull();
  });

  describe('on a copy of the tree', () => {
    let tmp: string;
    const write = (rel: string, text: string) => {
      fs.mkdirSync(path.dirname(path.join(tmp, rel)), { recursive: true });
      fs.writeFileSync(path.join(tmp, rel), text);
    };
    beforeEach(() => {
      tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'harnesses-'));
      copyTree(ROOT, tmp);
    });
    afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

    it('notices a slot edited without regenerating', () => {
      expect(generateSlotsModuleText(tmp)).toBe(fs.readFileSync(slotsFileFor(ROOT), 'utf8'));
      write('cloud-base/scoring/rule-name-ban.md', 'Never name a rule.\n');
      expect(generateSlotsModuleText(tmp)).not.toBe(fs.readFileSync(slotsFileFor(ROOT), 'utf8'));
    });

    it('refuses an implementation slot that equals the base slot it overrides', () => {
      write('qwen3.8-27b/scoring/rule-name-ban.md', fs.readFileSync(path.join(ROOT, 'cloud-base/scoring/rule-name-ban.md'), 'utf8'));
      expect(() => generateSlotsModuleText(tmp)).toThrow(/equals the slot it overrides/);
    });

    it('refuses an override of a slot the base does not have, and a duplicated fragment', () => {
      write('qwen3.8-27b/scoring/made-up.md', 'Something new.\n');
      expect(() => generateSlotsModuleText(tmp)).toThrow(/overrides no slot/);
      fs.rmSync(path.join(tmp, 'qwen3.8-27b/scoring'), { recursive: true });
      write('cloud-base/scoring/copy.md', fs.readFileSync(path.join(ROOT, 'cloud-base/scoring/rule-name-ban.md'), 'utf8'));
      expect(() => generateSlotsModuleText(tmp)).toThrow(/include one fragment instead/);
    });

    it('carries a real override into every slot that includes it, and nothing else', () => {
      write('qwen3.8-27b/scoring/rule-name-ban.md', 'Never name a rule.\n');
      const out = generateSlotsModuleText(tmp);
      const block = out.slice(out.indexOf('export const QWEN3_8_27B_SLOTS'), out.indexOf('};', out.indexOf('export const QWEN3_8_27B_SLOTS')));
      expect(block).toContain('"scoring/rule-name-ban"');
      expect(block).toContain('"scoring/cloud-reason-system-prompt"');
      expect(block).not.toContain('"scoring/cloud-relevance-system-prompt"');
      expect(out).toMatch(/export const QWEN3_6_35B_A3B_SLOTS: Record<string, string> = \{\n\};/);
    });
  });
});

describe('slot templates', () => {
  it('fills values and picks blocks as the template literal it replaced did', () => {
    const t = 'A{{#if on}} on{{else}} off{{/if}}{{#unless on}}!{{/unless}} {{n}}';
    expect(render(t, { on: true, n: 3 })).toBe('A on 3');
    expect(render(t, { on: '', n: 'x' })).toBe('A off! x');
    expect(render('{{v}}', { v: '{{w}}' })).toBe('{{w}}');
    expect(() => render('{{v}}', {})).toThrow(/no value/);
    expect(() => parseTemplate('{{#if a}}x')).toThrow(/never closed/);
    expect(() => parseTemplate('{{#if a}}x{{/unless}}')).toThrow(/wrong block/);
    expect(() => parseTemplate('{{ odd }}')).toThrow(/unknown tag/);
  });
});
