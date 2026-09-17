/**
 * Compiles lib/mera-harness/skills/persona/**.md into index.generated.ts.
 *
 *   npx tsx lib/mera-harness/skills/generate.ts           # write
 *   npx tsx lib/mera-harness/skills/generate.ts --check   # verify, exit 1 on drift
 *
 * Everything here is a hard failure, never a warning and never a skip: a skipped
 * skill is a router that calls load_skill on an id the module does not hold.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

const SKILLS_DIR = path.join(__dirname, 'persona');
const OUT_FILE = path.join(__dirname, 'index.generated.ts');
const EXPECTATIONS = path.join(SKILLS_DIR, 'expectations', 'topics.json');

/**
 * Canonical emission order. Every markdown file's id MUST appear here, which is
 * what catches a rename: `facts/origins.md` is not in this list and fails.
 *
 * The reverse is NOT checked. An id here with no file yet is simply not emitted,
 * so the library can ship in stages (the topic half lands before the fact half).
 * Nothing is lost by that: `PersonaSkillId` is derived from what is emitted, so
 * a consumer referencing a skill that does not exist yet gets a compile error at
 * its own call site, which names the caller instead of naming this file.
 */
const SKILL_IDS = [
  'router',
  'facts/generic',
  'facts/residence',
  'facts/origin',
  'facts/profession',
  'facts/family',
  'topics/generic',
  'topics/residence',
  'topics/origin',
  'topics/profession',
  'topics/family',
  'conversation/question',
  'conversation/correction',
] as const;
type SkillId = (typeof SKILL_IDS)[number];

const BUDGET: Record<string, number> = { router: 1800 };
const DEFAULT_BUDGET = 1200;

/** Required section headings in each preamble. A leaf may restate none of these,
 *  so dropping one here strips it from four leaves at once with every file still
 *  individually valid. Only an explicit check catches it. */
const PREAMBLE_SECTIONS: Record<string, string[]> = {
  'facts/generic': ['## Output', '## Exclusions', '## Never', '## Punctuation'],
  'topics/generic': ['## Output', '## Exclusions', '## Banned shapes', '## Punctuation'],
};

/** A topic call is terminal: no tools, no earlier turn, nothing after the array. */
const TERMINAL_BANNED = [
  'load_skill', 'find_similar_facts', 'lookup_place', 'ask_choice',
  'saveExtractedFacts', 'router', 'you were given',
];
/** Router and fact skills run thinking off, so no phrasing that invites a trace. */
const DELIBERATION_BANNED = [
  'reason about', 'consider whether', 'think through', 'weigh whether', 'decide based on',
];

const EM_DASH = '—';
const EN_DASH = '–';

interface Skill {
  id: SkillId;
  name: string;
  description: string;
  when: string[];
  outputs: string[];
  examples: string[];
  body: string;
}

const errors: string[] = [];
const fail = (file: string, line: number | null, msg: string) =>
  errors.push(`${file}${line === null ? '' : `:${line}`}: ${msg}`);

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name < b.name ? -1 : 1)) {
    if (e.name === 'expectations') continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(p));
    else if (e.name.endsWith('.md')) out.push(p);
  }
  return out;
}

/**
 * Frontmatter reader. Deliberately NOT a YAML library and deliberately not a
 * split on every colon: `description` is a sentence and will contain one.
 */
function parseFrontmatter(file: string, text: string): Omit<Skill, 'id' | 'body'> & { id: string; body: string } | null {
  if (!text.startsWith('---\n')) { fail(file, 1, 'file must open with a --- frontmatter fence'); return null; }
  const end = text.indexOf('\n---\n', 3);
  if (end === -1) { fail(file, 1, 'frontmatter fence is never closed'); return null; }
  const fmLines = text.slice(4, end).split('\n');
  // The body is everything after the closing fence to EOF, taken verbatim.
  // It legitimately contains ```json blocks, so nothing here may treat an inner
  // fence as a terminator.
  const body = text.slice(end + 5);

  const scalars: Record<string, string> = {};
  const lists: Record<string, string[]> = {};
  let current: string | null = null;

  for (let i = 0; i < fmLines.length; i++) {
    const raw = fmLines[i];
    const ln = i + 2;
    if (raw.trim() === '') continue;
    const item = /^  - (.*)$/.exec(raw);
    if (item) {
      if (!current) { fail(file, ln, 'list item with no list key above it'); continue; }
      const v = item[1].trim();
      if (!(v.startsWith('"') && v.endsWith('"') && v.length >= 2)) {
        fail(file, ln, 'every list item must be a double-quoted string'); continue;
      }
      try { lists[current].push(JSON.parse(v)); }
      catch { fail(file, ln, 'list item is not valid JSON string syntax'); }
      continue;
    }
    const listKey = /^(when|outputs|examples):$/.exec(raw);
    if (listKey) { current = listKey[1]; lists[current] = lists[current] ?? []; continue; }
    const scalarKey = /^(id|name|description): (.*)$/.exec(raw);
    if (scalarKey) {
      current = null;
      const key = scalarKey[1]; const v = scalarKey[2].trim();
      if (v.startsWith('"')) {
        if (!v.endsWith('"') || v.length < 2) { fail(file, ln, `${key} opens a quote it does not close`); continue; }
        try { scalars[key] = JSON.parse(v); } catch { fail(file, ln, `${key} is not valid JSON string syntax`); }
      } else if (v.includes(':')) {
        fail(file, ln, `${key} contains a colon and must be double-quoted`);
      } else scalars[key] = v;
      continue;
    }
    fail(file, ln, `unrecognised frontmatter line: ${raw.slice(0, 60)}`);
  }

  for (const k of ['id', 'name', 'description']) if (!scalars[k]) fail(file, null, `missing required key: ${k}`);
  for (const k of ['when', 'outputs']) if (!lists[k]?.length) fail(file, null, `missing or empty required list: ${k}`);

  return {
    id: scalars.id ?? '', name: scalars.name ?? '', description: scalars.description ?? '',
    when: lists.when ?? [], outputs: lists.outputs ?? [], examples: lists.examples ?? [], body,
  };
}

function estimateTokens(s: string): number { return Math.ceil(s.length / 4); }

function readSkills(): Skill[] {
  const files = walk(SKILLS_DIR);
  const byId = new Map<string, Skill>();

  for (const file of files) {
    const rel = path.relative(SKILLS_DIR, file).replace(/\\/g, '/');
    const pathId = rel.replace(/\.md$/, '');
    const text = fs.readFileSync(file, 'utf8');
    const parsed = parseFrontmatter(file, text);
    if (!parsed) continue;

    if (parsed.id !== pathId) fail(file, null, `id "${parsed.id}" does not match its path "${pathId}"`);
    if (!(SKILL_IDS as readonly string[]).includes(pathId)) fail(file, null, `"${pathId}" is not in SKILL_IDS`);

    const { body } = parsed;
    if (text.includes(EM_DASH) || text.includes(EN_DASH)) fail(file, null, 'contains an em dash or en dash');
    for (const m of ['TODO', 'FIXME', 'XXX']) if (body.includes(m)) fail(file, null, `body contains ${m}`);

    const budget = BUDGET[pathId] ?? DEFAULT_BUDGET;
    const tokens = estimateTokens(body);
    if (tokens > budget) fail(file, null, `body is ${tokens} tokens, over its ${budget} budget`);

    // examples <-> worked example: set-equal in BOTH directions. The forward
    // direction alone lets a 13th example topic be added to the body and
    // forgotten in the frontmatter, and the echo check then goes blind on
    // exactly the string just added.
    const m = /```json\n([\s\S]*?)\n```/.exec(body);
    if (m) {
      let arr: unknown;
      try { arr = JSON.parse(m[1]); } catch { fail(file, null, 'worked example is not valid JSON'); }
      if (Array.isArray(arr)) {
        const inBody = new Set(arr.map(String));
        const inFm = new Set(parsed.examples);
        const onlyBody = [...inBody].filter((x) => !inFm.has(x));
        const onlyFm = [...inFm].filter((x) => !inBody.has(x));
        if (onlyBody.length) fail(file, null, `in the worked example but not in examples: ${JSON.stringify(onlyBody)}`);
        if (onlyFm.length) fail(file, null, `in examples but not in the worked example: ${JSON.stringify(onlyFm)}`);
      }
    } else if (parsed.examples.length) {
      fail(file, null, 'has an examples list but no ```json worked example in the body');
    }

    const required = PREAMBLE_SECTIONS[pathId];
    if (required) for (const h of required) {
      if (!body.includes(`\n${h}`)) fail(file, null, `preamble is missing its required "${h}" section`);
    }

    if (pathId.startsWith('topics/')) {
      for (const w of TERMINAL_BANNED) {
        if (body.includes(w)) fail(file, null, `topic body mentions "${w}"; a topic call is terminal and has no tools and no earlier turn`);
      }
      const noFences = body.replace(/```[\s\S]*?```/g, '');
      if (noFences.includes('?')) fail(file, null, 'topic body asks a question outside a fenced example; a topic call has no reader to answer it');
    }
    if (pathId === 'router' || pathId.startsWith('facts/')) {
      for (const w of DELIBERATION_BANNED) {
        if (body.includes(w)) fail(file, null, `"${w}" invites a reasoning trace this call does not have (thinking is off)`);
      }
    }

    if (byId.has(pathId)) fail(file, null, `duplicate id "${pathId}"`);
    byId.set(pathId, { ...parsed, id: pathId as SkillId });
  }

  if (byId.size === 0) fail(SKILLS_DIR, null, 'no skill markdown found');
  return SKILL_IDS.filter((id) => byId.has(id)).map((id) => byId.get(id)!);
}

function validateExpectations(presentTopicIds: string[]): void {
  if (!fs.existsSync(EXPECTATIONS)) { fail(EXPECTATIONS, null, 'expectations file is missing'); return; }
  const raw = fs.readFileSync(EXPECTATIONS, 'utf8');
  if (raw.includes(EM_DASH) || raw.includes(EN_DASH)) fail(EXPECTATIONS, null, 'contains an em dash or en dash');
  let doc: any;
  try { doc = JSON.parse(raw); } catch (e) { fail(EXPECTATIONS, null, `is not valid JSON: ${e}`); return; }
  if (doc.version !== 1) fail(EXPECTATIONS, null, 'version must be 1');
  const cases: any[] = Array.isArray(doc.cases) ? doc.cases : [];
  if (!cases.length) { fail(EXPECTATIONS, null, 'cases is empty'); return; }

  for (const c of cases) {
    const where = `case "${c.id}"`;
    if (!Array.isArray(c.countRange) || c.countRange.length !== 2) { fail(EXPECTATIONS, null, `${where}: countRange must be [lo, hi]`); continue; }
    const [lo, hi] = c.countRange;
    if (!(lo >= 1 && lo <= hi && hi <= 12)) fail(EXPECTATIONS, null, `${where}: countRange ${JSON.stringify(c.countRange)} must satisfy 1 <= lo <= hi <= 12`);
    for (const [rung, pats] of Object.entries(c.ladder ?? {})) {
      for (const p of pats as string[]) {
        // Length is measured WITH significant whitespace: "eu " is a 3-character
        // pattern whose trailing space is the guard against "museum".
        if (p.length < 3) fail(EXPECTATIONS, null, `${where}: ladder.${rung} pattern ${JSON.stringify(p)} is under 3 characters and will substring-match unrelated words`);
      }
    }
    if (c.id !== 'generic' && !c.id.startsWith('generic-') && !(c.factMatches ?? []).length) {
      fail(EXPECTATIONS, null, `${where}: factMatches may only be empty for a generic case`);
    }
  }

  for (const id of presentTopicIds) {
    const leaf = id.slice('topics/'.length);
    const mine = cases.filter((c) => c.id === leaf || String(c.id).startsWith(`${leaf}-`));
    if (mine.length < 3) {
      fail(EXPECTATIONS, null, `"${id}" has ${mine.length} case(s); three are required so ladder and fieldGeneric coverage rests on more than one fact`);
      continue;
    }
    // Three cases that differ only in place names test one shape three times.
    // The distinguishing axis differs by skill: place skills vary their rungs,
    // profession varies fieldGeneric, generic varies the fact itself.
    const axis = new Set(mine.map((c) => JSON.stringify([
      Object.keys(c.ladder ?? {}).sort(),
      (c.fieldGeneric ?? []).slice().sort(),
      (c.factMatches ?? []).slice().sort(),
    ])));
    if (axis.size < mine.length) fail(EXPECTATIONS, null, `"${id}": its cases do not differ in ladder rungs, fieldGeneric or factMatches`);
  }
}

function render(skills: Skill[]): string {
  const L: string[] = [];
  L.push('// GENERATED by lib/mera-harness/skills/generate.ts from skills/persona/**.');
  L.push('// Do not edit. Run `npm run skills:generate` after changing a skill.');
  L.push('// No imports: this module is loaded by the purity-tested harness core.');
  L.push('');
  L.push('export const PERSONA_SKILL_INDEX = [');
  for (const s of skills) {
    L.push('  {');
    L.push(`    id: ${JSON.stringify(s.id)},`);
    L.push(`    description: ${JSON.stringify(s.description)},`);
    L.push(`    when: [${s.when.map((w) => JSON.stringify(w)).join(', ')}],`);
    L.push(`    examples: [${s.examples.map((e) => JSON.stringify(e)).join(', ')}],`);
    L.push('  },');
  }
  // No type annotation on this binding. An annotation erases `as const`, the
  // literal ids widen to string, and PersonaSkillId below collapses with it.
  L.push('] as const;');
  L.push('');
  L.push('/** Derived from the index, so the index is the single source of truth. */');
  L.push("export type PersonaSkillId = (typeof PERSONA_SKILL_INDEX)[number]['id'];");
  L.push('export type PersonaSkillIndexEntry = (typeof PERSONA_SKILL_INDEX)[number];');
  L.push('');
  L.push(`export const PERSONA_SKILL_IDS = [${skills.map((s) => JSON.stringify(s.id)).join(', ')}] as const;`);
  L.push('');
  L.push('/** Annotated deliberately: Record over the derived union makes a missing');
  L.push(' *  body a compile error rather than an undefined system prompt. */');
  L.push('export const PERSONA_SKILLS: Record<PersonaSkillId, string> = {');
  for (const s of skills) L.push(`  ${JSON.stringify(s.id)}: ${JSON.stringify(s.body)},`);
  L.push('};');
  L.push('');
  return L.join('\n');
}

function main(): void {
  const check = process.argv.includes('--check');
  const skills = readSkills();
  validateExpectations(skills.map((s) => s.id).filter((id) => id.startsWith('topics/')));

  const out = render(skills);
  if (/^\s*(import|const .*= require\()/m.test(out)) errors.push('rendered module contains an import or require; it must stay dependency-free');
  if (/PERSONA_SKILL_INDEX\s*:/.test(out)) errors.push('rendered module annotates PERSONA_SKILL_INDEX, which erases as const and collapses PersonaSkillId to string');

  if (errors.length) {
    console.error(`\n${errors.length} problem(s):\n`);
    for (const e of errors) console.error(`  ${e}`);
    console.error('');
    process.exit(1);
  }

  const existing = fs.existsSync(OUT_FILE) ? fs.readFileSync(OUT_FILE, 'utf8') : null;
  if (check) {
    if (existing !== out) {
      console.error('index.generated.ts is stale. Run: npm run skills:generate');
      if (existing !== null) {
        const a = existing.split('\n'); const b = out.split('\n');
        for (let i = 0; i < Math.max(a.length, b.length); i++) {
          if (a[i] !== b[i]) { console.error(`  first difference at line ${i + 1}:\n    on disk: ${String(a[i]).slice(0, 110)}\n    fresh:   ${String(b[i]).slice(0, 110)}`); break; }
        }
      }
      process.exit(1);
    }
    console.log(`index.generated.ts is up to date (${skills.length} skills).`);
    return;
  }

  if (existing !== out) fs.writeFileSync(OUT_FILE, out, 'utf8');
  const largest = skills.reduce((a, b) => (estimateTokens(a.body) > estimateTokens(b.body) ? a : b));
  const total = skills.reduce((n, s) => n + estimateTokens(s.body), 0);
  console.log(`${skills.length} skills, ${total} tokens total, largest ${estimateTokens(largest.body)} (${largest.id})${existing === out ? ' [unchanged]' : ''}`);
}

main();
