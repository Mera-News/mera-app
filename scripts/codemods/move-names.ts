// Per-name moves for move-module.ts. Entry: {"names": [...], "fromModule": "lib/x/a.ts", "toModule": "lib/x/b.ts"}.
// The code was moved by hand first (names live in toModule, no re-export left in fromModule). This only
// rewrites importers: the listed names split off to an import/re-export of toModule (merged into an
// existing named import of toModule when there is one), aliases and `type` modifiers kept, the importer's
// `@/`-or-relative style kept. A namespace import or require() of fromModule that uses a listed name is
// reported for a hand edit, as is any jest.mock of fromModule (R10).
// Several entries may share a fromModule (one module split into several): they are planned together,
// so one import of fromModule splits into the kept names plus one statement per toModule. A name may
// appear in only one entry per fromModule.
import * as fs from 'fs';
import * as path from 'path';
import * as ts from 'typescript';
import { Edit, emitStatement, findRefs, formatSpec, MOCK_REFUSE, parse, resolveSpec, styleOf } from './lib';

export interface NameMove { names: string[]; fromModule: string; toModule: string }
export interface NamePlan {
  edits: Map<string, Edit[]>;
  log: string[];
  refused: string[];
  unresolved: string[];
}

const piece = (el: ts.ImportSpecifier | ts.ExportSpecifier) => el.getText();
const imported = (el: ts.ImportSpecifier | ts.ExportSpecifier) => (el.propertyName ?? el.name).text;

export function planNameMoves(root: string, files: string[], moves: NameMove[]): NamePlan {
  const plan: NamePlan = { edits: new Map(), log: [], refused: [], unresolved: [] };
  // fromModule -> (moved name -> its toModule), entries sharing a fromModule merged.
  const groups = new Map<string, Map<string, string>>();
  for (const mv of moves) {
    for (const m of [mv.fromModule, mv.toModule]) {
      if (!fs.existsSync(path.join(root, m))) throw new Error(`names entry: ${m} does not exist`);
    }
    const dest = fs.readFileSync(path.join(root, mv.toModule), 'utf8');
    const group = groups.get(mv.fromModule) ?? new Map<string, string>();
    groups.set(mv.fromModule, group);
    for (const n of mv.names) {
      if (!new RegExp(`\\b${n}\\b`).test(dest)) {
        throw new Error(`names entry: '${n}' not found in ${mv.toModule}; move the code by hand first`);
      }
      const prev = group.get(n);
      if (prev && prev !== mv.toModule) {
        throw new Error(`names entry: '${n}' from ${mv.fromModule} is listed for both ${prev} and ${mv.toModule}`);
      }
      group.set(n, mv.toModule);
    }
  }
  for (const [fromModule, dests] of groups) {
    const mv = { fromModule, names: [...dests.keys()] };
    const toModules = new Set(dests.values());
    for (const f of files) {
      if (f === fromModule || toModules.has(f)) continue;
      const { text, sf } = parse(root, f);
      const refs = findRefs(sf).filter((r) => resolveSpec(root, f, r.spec) === fromModule);
      if (!refs.length) continue;
      const add = (e: Edit, shown: string, line: number) => {
        if (!plan.edits.has(f)) plan.edits.set(f, []);
        plan.edits.get(f)!.push(e);
        plan.log.push(`${f}:${line}: ${shown}`);
      };
      // Named imports of toModule already in this file, one merge target per statement.
      const merges = new Map<ts.ImportDeclaration, string[]>();
      const existing = (toModule: string, typeOnly: boolean) =>
        sf.statements.find((s): s is ts.ImportDeclaration => {
          if (!ts.isImportDeclaration(s) || !ts.isStringLiteral(s.moduleSpecifier)) return false;
          const c = s.importClause;
          return resolveSpec(root, f, s.moduleSpecifier.text) === toModule && !!c &&
            c.isTypeOnly === typeOnly && !!c.namedBindings && ts.isNamedImports(c.namedBindings);
        });
      const used = (local: string) => {
        // Names read off a namespace local: undefined when the local is used in any other way.
        const seen = new Set<string>();
        let other = false;
        const visit = (n: ts.Node) => {
          if (ts.isImportDeclaration(n) || ts.isExportDeclaration(n)) return;
          if (ts.isIdentifier(n) && n.text === local) {
            const p = n.parent;
            if (ts.isPropertyAccessExpression(p) && p.expression === n) seen.add(p.name.text);
            else if (ts.isQualifiedName(p) && p.left === n) seen.add(p.right.text);
            else other = true;
          }
          ts.forEachChild(n, visit);
        };
        visit(sf);
        return other ? undefined : seen;
      };
      for (const ref of refs) {
        const where = `${f}:${ref.line}`;
        if (ref.kind === 'mock' && MOCK_REFUSE.has(ref.fn!)) {
          plan.refused.push(`${where}: jest.${ref.fn}('${ref.spec}') names ${mv.fromModule}`);
          continue;
        }
        const decl = ref.node;
        if (ts.isImportDeclaration(decl) || (ts.isExportDeclaration(decl) && decl.exportClause && ts.isNamedExports(decl.exportClause))) {
          const isImport = ts.isImportDeclaration(decl);
          const clause = isImport ? decl.importClause : undefined;
          if (isImport && clause?.namedBindings && ts.isNamespaceImport(clause.namedBindings)) {
            const u = used(clause.namedBindings.name.text);
            if (!u || mv.names.some((n) => u.has(n))) {
              plan.unresolved.push(`${where}: namespace import of ${mv.fromModule} may use a moved name (${mv.names.join(', ')})`);
            }
            continue;
          }
          const binding = isImport ? clause?.namedBindings : decl.exportClause;
          if (!binding || ts.isNamespaceImport(binding) || ts.isNamespaceExport(binding)) continue;
          const els = binding.elements as ts.NodeArray<ts.ImportSpecifier | ts.ExportSpecifier>;
          const moved = els.filter((e) => dests.has(imported(e)));
          if (!moved.length) continue;
          const kept = els.filter((e) => !dests.has(imported(e)));
          // toModule -> the moved specifiers bound for it, in first-seen order.
          const byDest = new Map<string, (ts.ImportSpecifier | ts.ExportSpecifier)[]>();
          for (const e of moved) {
            const to = dests.get(imported(e))!;
            byDest.set(to, [...(byDest.get(to) ?? []), e]);
          }
          const typeOnly = isImport ? !!clause!.isTypeOnly : decl.isTypeOnly;
          const st = styleOf(text, decl, ref);
          const start = decl.getStart(sf);
          const def = isImport ? clause!.name?.text : undefined;
          const parts: string[] = [];
          const shown: string[] = [];
          if (kept.length || def) {
            parts.push(emitStatement(isImport ? 'import' : 'export', typeOnly, def, kept.map(piece), ref.spec, st));
          }
          for (const [to, group] of byDest) {
            const toSpec = formatSpec(ref.spec, to, f);
            const target = isImport ? existing(to, typeOnly) : undefined;
            if (target) merges.set(target, [...(merges.get(target) ?? []), ...group.map(piece)]);
            else parts.push(emitStatement(isImport ? 'import' : 'export', typeOnly, undefined, group.map(piece), toSpec, st));
            shown.push(`${group.length} name(s) to '${toSpec}'${target ? ' (merged)' : ''}`);
          }
          let end = decl.getEnd();
          if (!parts.length) end = text[end] === '\n' ? end + 1 : end;
          add({ start, end, text: parts.join(`\n${st.pad}`) }, `split ${shown.join(', ')}`, ref.line);
        } else if (ref.kind === 'typeimport') {
          const q = (ref.node as ts.ImportTypeNode).qualifier;
          let first = q;
          while (first && ts.isQualifiedName(first)) first = first.left;
          const to = first ? dests.get((first as ts.Identifier).text) : undefined;
          if (to) {
            const toSpec = formatSpec(ref.spec, to, f);
            add({ start: ref.start, end: ref.end, text: toSpec }, `'${ref.spec}' -> '${toSpec}'`, ref.line);
          } else if (!first) {
            plan.unresolved.push(`${where}: typeof import('${ref.spec}') of the whole module may use a moved name`);
          }
        } else if (ref.kind === 'require' || ref.kind === 'dynamic') {
          let n: ts.Node = ref.node;
          while (ts.isParenthesizedExpression(n.parent) || ts.isAwaitExpression(n.parent) || ts.isAsExpression(n.parent)) n = n.parent;
          const p = n.parent;
          let read: string[] | undefined;
          if (ts.isPropertyAccessExpression(p) && p.expression === n) read = [p.name.text];
          else if (ts.isVariableDeclaration(p) && p.initializer === n && ts.isObjectBindingPattern(p.name)) {
            const b = p.name.elements;
            if (b.every((e) => !e.dotDotDotToken)) read = b.map((e) => (e.propertyName ?? e.name).getText());
          }
          if (!read || read.some((r) => dests.has(r))) {
            plan.unresolved.push(`${where}: ${ref.kind}('${ref.spec}') may use a moved name (${mv.names.join(', ')})`);
          }
        }
      }
      for (const [target, extra] of merges) {
        const c = target.importClause!;
        const els = (c.namedBindings as ts.NamedImports).elements.map(piece);
        const all = [...els, ...extra.filter((e) => !els.includes(e))];
        const lit = target.moduleSpecifier as ts.StringLiteral;
        const st = styleOf(text, target, { start: lit.getStart(sf) + 1 } as never);
        add({ start: target.getStart(sf), end: target.getEnd(), text: emitStatement('import', c.isTypeOnly, c.name?.text, all, lit.text, st) }, `merged ${extra.length} name(s) into the import of '${lit.text}'`, sf.getLineAndCharacterOfPosition(target.getStart(sf)).line + 1);
      }
    }
  }
  return plan;
}
