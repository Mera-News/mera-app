// Renders a prompt slot's template. PURE, imports nothing: the news harness and Node runners load it.
//
//   {{name}}                         the value, as `${name}` would write it
//   {{#if name}}...{{else}}...{{/if}} a block chosen by the value's truthiness ({{else}} optional)
//   {{#unless name}}...{{/unless}}    the reverse
//
// `{{> id}}` includes never reach here: harness:generate expands them. A value is inserted as is and
// never parsed again, so publisher text holding braces cannot open a tag.
export type TemplateVars = Record<string, unknown>;

type Node = string | { v: string } | { block: string; neg: boolean; then: Node[]; else: Node[] };

const TAG = /\{\{(#if |#unless |\/if|\/unless|else)?([A-Za-z_$][\w$]*)?\}\}/g;
const parsed = new Map<string, Node[]>();

/** Parses a template into its nodes. Throws on an unbalanced block or a tag it does not know. */
export function parseTemplate(template: string): Node[] {
  const root: Node[] = [];
  const stack: { node: Extract<Node, { block: string }>; inElse: boolean }[] = [];
  const out = () => {
    const top = stack[stack.length - 1];
    return top ? (top.inElse ? top.node.else : top.node.then) : root;
  };
  let at = 0;
  for (const m of template.matchAll(TAG)) {
    const i = m.index ?? 0;
    if (i > at) out().push(template.slice(at, i));
    at = i + m[0].length;
    const [, kind, name] = m;
    if (kind === '#if ' || kind === '#unless ') {
      if (!name) throw new Error(`template: ${m[0]} names no value`);
      const node = { block: name, neg: kind === '#unless ', then: [] as Node[], else: [] as Node[] };
      out().push(node);
      stack.push({ node, inElse: false });
    } else if (kind === 'else' || kind === '/if' || kind === '/unless') {
      const top = stack[stack.length - 1];
      if (!top || name) throw new Error(`template: stray ${m[0]}`);
      if (kind === 'else') {
        if (top.inElse) throw new Error('template: two {{else}} in one block');
        top.inElse = true;
      } else {
        if ((kind === '/if') === top.node.neg) throw new Error(`template: ${m[0]} closes the wrong block`);
        stack.pop();
      }
    } else if (name) {
      out().push({ v: name });
    }
  }
  if (stack.length) throw new Error(`template: {{#${stack[0].node.neg ? 'unless' : 'if'} ${stack[0].node.block}}} is never closed`);
  const tail = template.slice(at);
  if (tail) out().push(tail);
  for (const s of flatten(root)) if (s.includes('{{')) throw new Error(`template: unknown tag near "${s.slice(s.indexOf('{{'), s.indexOf('{{') + 30)}"`);
  return root;
}

function* flatten(nodes: Node[]): Generator<string> {
  for (const n of nodes) {
    if (typeof n === 'string') yield n;
    else if ('block' in n) {
      yield* flatten(n.then);
      yield* flatten(n.else);
    }
  }
}

/** Every value name the template reads. */
export function templateVars(template: string): Set<string> {
  const names = new Set<string>();
  const walk = (nodes: Node[]) => {
    for (const n of nodes) {
      if (typeof n === 'string') continue;
      if ('v' in n) names.add(n.v);
      else {
        names.add(n.block);
        walk(n.then);
        walk(n.else);
      }
    }
  };
  walk(parseTemplate(template));
  return names;
}

export function render(template: string, vars: TemplateVars): string {
  let nodes = parsed.get(template);
  if (!nodes) {
    nodes = parseTemplate(template);
    parsed.set(template, nodes);
  }
  const value = (name: string) => {
    if (!(name in vars)) throw new Error(`template: no value for "${name}"`);
    return vars[name];
  };
  const emit = (list: Node[]): string => {
    let s = '';
    for (const n of list) {
      if (typeof n === 'string') s += n;
      else if ('v' in n) s += `${value(n.v)}`;
      else s += emit(Boolean(value(n.block)) !== n.neg ? n.then : n.else);
    }
    return s;
  };
  return emit(nodes);
}
