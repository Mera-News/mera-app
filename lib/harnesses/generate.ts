/**
 * harness:generate. Compiles every harness folder's prompt slots (`*.md`) into slots.generated.ts,
 * and the cloud base's persona skills (`cloud-base/skills/**.md`) into
 * lib/mera-harness/skills/index.generated.ts. Metro cannot read a directory or a .md at runtime,
 * so the app imports the generated modules.
 *
 *   npm run harness:generate             # write
 *   npm run harness:generate -- --check  # verify, exit 1 on drift
 *
 * A slot file is the prompt text byte for byte, ending in exactly one newline that is not part of
 * it. It may open with one `<!-- ... -->` note for readers, which is dropped. Inside, `{{> id}}`
 * includes another slot of the same folder (expanded here) and `{{name}}`, `{{#if name}}`,
 * `{{#unless name}}` are filled at runtime by template.ts.
 *
 * An implementation folder holds only harness.json plus overrides: a slot file at the same path as
 * one in its base, with different text. Its generated map carries just the slots whose expanded
 * text differs from the base, so a base fragment it overrides reaches every slot that includes it.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { firstDifference, generateModuleText as generateSkillsModule, outFileFor, SKILLS_ROOT } from '../mera-harness/skills/generate';
import { parseTemplate } from './template';

export const HARNESSES_ROOT = __dirname;
export const slotsFileFor = (root: string): string => path.join(root, 'slots.generated.ts');
/** The persona skills: compiled by the skills generator, not as slots. */
const SKILLS_DIR = 'skills';
const NOTE = /^<!--[\s\S]*?-->\n/;
const INCLUDE = /\{\{> ([a-z0-9][a-z0-9/-]*)\}\}/g;

export class HarnessGenerationError extends Error {
  constructor(public readonly problems: string[]) {
    super(`${problems.length} problem(s):\n  ${problems.join('\n  ')}`);
    this.name = 'HarnessGenerationError';
  }
}

interface Folder {
  name: string;
  extends: string | null;
  /** Slot id (path without .md) -> raw text after the note and the final newline are dropped. */
  slots: Map<string, string>;
  /** Slot id -> file, for messages. */
  files: Map<string, string>;
}

function walk(dir: string, rel = ''): string[] {
  const out: string[] = [];
  for (const e of fs.readdirSync(path.join(dir, rel), { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) {
      if (!rel && e.name === SKILLS_DIR) continue;
      out.push(...walk(dir, r));
    } else if (e.name.endsWith('.md')) out.push(r);
  }
  return out;
}

/** The slot text a file holds. Exported for the guard test, which compares raw override files. */
export function slotText(raw: string): string | null {
  if (!raw.endsWith('\n')) return null;
  return raw.replace(NOTE, '').slice(0, -1);
}

function readFolders(root: string, problems: string[]): Folder[] {
  const folders: Folder[] = [];
  for (const name of fs.readdirSync(root).sort()) {
    const dir = path.join(root, name);
    const json = path.join(dir, 'harness.json');
    if (!fs.statSync(dir).isDirectory() || !fs.existsSync(json)) continue;
    const f: Folder = { name, extends: JSON.parse(fs.readFileSync(json, 'utf8')).extends ?? null, slots: new Map(), files: new Map() };
    for (const rel of walk(dir)) {
      const file = path.join(name, rel);
      const text = slotText(fs.readFileSync(path.join(dir, rel), 'utf8'));
      if (text === null) {
        problems.push(`${file}: must end with one newline (it is not part of the prompt)`);
        continue;
      }
      const id = rel.replace(/\.md$/, '');
      if (!/^[a-z0-9][a-z0-9/-]*$/.test(id)) problems.push(`${file}: slot ids are lowercase kebab-case paths`);
      f.slots.set(id, text);
      f.files.set(id, file);
    }
    folders.push(f);
  }
  return folders;
}

/** Every slot the folder sees: its base's, overlaid by each folder down the chain. */
function overlay(folder: Folder, byName: Map<string, Folder>): Map<string, string> {
  const chain: Folder[] = [];
  for (let at: Folder | undefined = folder; at; at = at.extends ? byName.get(at.extends) : undefined) {
    if (chain.includes(at)) break;
    chain.unshift(at);
  }
  const out = new Map<string, string>();
  for (const f of chain) for (const [id, text] of f.slots) out.set(id, text);
  return out;
}

function expandAll(name: string, slots: Map<string, string>, problems: string[]): Map<string, string> {
  const done = new Map<string, string>();
  const expand = (id: string, stack: string[]): string => {
    const hit = done.get(id);
    if (hit !== undefined) return hit;
    if (stack.includes(id)) {
      problems.push(`${name}: include cycle ${[...stack, id].join(' -> ')}`);
      return '';
    }
    const text = slots.get(id) ?? '';
    const out = text.replace(INCLUDE, (_m, target: string) => {
      if (!slots.has(target)) {
        problems.push(`${name}/${id}: includes "${target}", which is not a slot of this folder`);
        return '';
      }
      return expand(target, [...stack, id]);
    });
    done.set(id, out);
    return out;
  };
  for (const id of slots.keys()) {
    const out = expand(id, []);
    if (out.includes('{{>')) problems.push(`${name}/${id}: malformed include (write {{> id}} with one space)`);
    try {
      parseTemplate(out);
    } catch (e) {
      problems.push(`${name}/${id}: ${(e as Error).message}`);
    }
  }
  return done;
}

const constName = (folder: string) => `${folder.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}_SLOTS`;
const typeName = (folder: string) => folder.replace(/(^|[^a-zA-Z0-9]+)([a-zA-Z0-9])/g, (_m, _s, c: string) => c.toUpperCase()) + 'Slot';

/** The whole slot pipeline, in memory: what the freshness test and the CLI both call. */
export function generateSlotsModuleText(root: string = HARNESSES_ROOT): string {
  const problems: string[] = [];
  const folders = readFolders(root, problems);
  const byName = new Map(folders.map((f) => [f.name, f]));

  // No two slot files anywhere hold the same bytes: shared text is one fragment, included.
  const seen = new Map<string, string>();
  for (const f of folders)
    for (const [id, text] of f.slots) {
      const other = seen.get(text);
      if (other) problems.push(`${f.files.get(id)}: same text as ${other}; include one fragment instead`);
      else seen.set(text, f.files.get(id) ?? id);
    }

  // Each slot is one const, written as its own text with includes as references to other consts,
  // so a fragment shared by ten prompts sits in the bundle once.
  const L: string[] = [
    '// GENERATED by lib/harnesses/generate.ts from lib/harnesses/*/**.md. Do not edit.',
    '// Run `npm run harness:generate` after changing a slot. No imports: the news harness loads it.',
    '',
  ];
  const registry: string[] = [];
  /** Folder -> slot id -> the const holding its text as that folder sees it. */
  const resolved = new Map<string, Map<string, string>>();
  const depth = (f: Folder): number => {
    let d = 0;
    for (let at = f; at.extends && byName.has(at.extends) && d < folders.length; at = byName.get(at.extends) as Folder) d++;
    return d;
  };
  let n = 0;
  for (const f of [...folders].sort((x, y) => depth(x) - depth(y) || (x.name < y.name ? -1 : 1))) {
    if (f.extends !== null && !byName.has(f.extends)) {
      problems.push(`${f.name}: extends "${f.extends}", which is not a folder`);
      continue;
    }
    const isBase = f.extends === null;
    const view = overlay(f, byName);
    const expanded = expandAll(f.name, view, problems);
    const parentNames = isBase ? new Map<string, string>() : resolved.get(f.extends ?? '') ?? new Map<string, string>();
    let own: string[];
    if (isBase) own = [...expanded.keys()];
    else {
      const parentView = overlay(byName.get(f.extends ?? '') as Folder, byName);
      for (const [id, text] of f.slots) {
        if (!parentView.has(id)) problems.push(`${f.files.get(id)}: overrides no slot of "${f.extends}"`);
        else if (parentView.get(id) === text) problems.push(`${f.files.get(id)}: equals the slot it overrides; delete it`);
      }
      const parentExpanded = expandAll(`${f.name} (parent)`, parentView, []);
      own = [...expanded].filter(([id, text]) => parentExpanded.get(id) !== text).map(([id]) => id);
    }
    own.sort();
    const names = new Map(parentNames);
    for (const id of own) names.set(id, `s${n++}`);
    // Emit in dependency order: a const only references consts above it.
    const emitted = new Set<string>();
    const emit = (id: string, stack: string[]) => {
      if (emitted.has(id) || !own.includes(id) || stack.includes(id)) return;
      const parts: string[] = [];
      let at = 0;
      const raw = view.get(id) ?? '';
      for (const m of raw.matchAll(INCLUDE)) {
        const i = m.index ?? 0;
        if (i > at) parts.push(JSON.stringify(raw.slice(at, i)));
        emit(m[1], [...stack, id]);
        parts.push(names.get(m[1]) ?? '""');
        at = i + m[0].length;
      }
      if (at < raw.length || parts.length === 0) parts.push(JSON.stringify(raw.slice(at)));
      L.push(`const ${names.get(id)} = ${parts.join(' + ')};`);
      emitted.add(id);
    };
    if (own.length) L.push(`// ${f.name}`);
    for (const id of own) emit(id, []);
    if (own.length) L.push('');
    resolved.set(f.name, names);
    if (isBase && own.length === 0) continue;
    if (isBase) {
      L.push(`export type ${typeName(f.name)} =`);
      for (const id of own) L.push(`  | ${JSON.stringify(id)}`);
      L.push('  ;', '');
      L.push(`export const ${constName(f.name)}: Record<${typeName(f.name)}, string> = {`);
    } else {
      L.push(`/** ${f.name}: only the slots whose text differs from its base. */`);
      L.push(`export const ${constName(f.name)}: Record<string, string> = {`);
    }
    for (const id of own) L.push(`  ${JSON.stringify(id)}: ${names.get(id)},`);
    L.push('};', '');
    registry.push(`  ${JSON.stringify(f.name)}: ${constName(f.name)},`);
  }
  L.push('/** Folder -> its slots (a base: all of them; an implementation: its overrides only). */');
  L.push('export const HARNESS_SLOTS: Record<string, Record<string, string>> = {', ...registry.sort(), '};', '');
  if (problems.length) throw new HarnessGenerationError(problems);
  return L.join('\n');
}

function main(): void {
  const check = process.argv.includes('--check');
  const outputs: [string, () => string][] = [
    [slotsFileFor(HARNESSES_ROOT), () => generateSlotsModuleText()],
    [outFileFor(SKILLS_ROOT), () => generateSkillsModule()],
  ];
  let stale = false;
  for (const [file, generate] of outputs) {
    let out: string;
    try {
      out = generate();
    } catch (e) {
      const problems = (e as { problems?: string[] }).problems;
      if (!problems) throw e;
      console.error(`\n${problems.length} problem(s):\n`);
      for (const p of problems) console.error(`  ${p}`);
      process.exit(1);
    }
    const existing = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
    const rel = path.relative(process.cwd(), file);
    if (check) {
      if (existing !== out) {
        stale = true;
        console.error(`${rel} is stale. Run: npm run harness:generate`);
        console.error(`  first difference at ${existing === null ? 'file is missing' : firstDifference(existing, out)}`);
      } else console.log(`${rel} is up to date.`);
    } else {
      if (existing !== out) fs.writeFileSync(file, out, 'utf8');
      console.log(`${rel}: ${out.length} bytes${existing === out ? ' [unchanged]' : ''}`);
    }
  }
  if (stale) process.exit(1);
}

// Only when run as a script. An importing test must not trip process.exit.
if (require.main === module) main();
