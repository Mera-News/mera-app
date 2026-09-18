// harness-local - build the blinded rater view of an agent run.
//
// Rates WHAT THE USER SEES: cleanProse is applied the way the loop applies it
// before the reply reaches the bubble, so a rater does not flag dashes nobody
// saw. Reads rater-rows-reply.jsonl (already blinded by rater-export.ts) and
// writes rater-view.jsonl next to it.
//
// Node-only: never imported by the app bundle.
import { readFileSync, writeFileSync } from 'node:fs';
import { cleanProse } from '../../lib/mera-harness/core/prose';

const D = '.local-test-data/runs/20260918-142924-g4';
const rows = readFileSync(`${D}/rater-rows-reply.jsonl`, 'utf8')
  .split('\n').filter(Boolean).map((l) => JSON.parse(l));

const out = rows.map((r: any) => {
  const msgs = (r.input?.messages ?? []) as { role: string; content: string }[];
  const state = msgs.find((m) => m.content.startsWith('<state>'))?.content ?? '';
  const userMsg = msgs.filter((m) => m.role === 'user' && !m.content.startsWith('<'))
    .map((m) => m.content).join(' ');
  return {
    rowId: r.rowId,
    arm: r.arm,
    cohort: r.cohort,
    userMessage: userMsg,
    stateLine: state.replace(/^<state>|<\/state>$/g, ''),
    // WHAT THE USER SEES. cleanProse is applied by the loop before the reply is
    // written to the bubble, so rating rawOutput would flag dashes nobody saw.
    reply: cleanProse(r.rawOutput ?? ''),
    toolsCalled: (r.toolCalls ?? []).map((t: any) => t.name),
  };
});
writeFileSync(`${D}/rater-view.jsonl`, out.map((o) => JSON.stringify(o)).join('\n') + '\n');
console.log(`${out.length} rows -> ${D}/rater-view.jsonl`);
const dashes = out.filter((o) => /[—–]/.test(o.reply)).length;
console.log(`em/en dashes surviving cleanProse: ${dashes}/${out.length}`);
console.log(`empty replies: ${out.filter((o) => !o.reply.trim()).length}/${out.length}`);
