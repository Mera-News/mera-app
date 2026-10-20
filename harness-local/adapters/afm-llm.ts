// harness-local — Apple's on-device Foundation Model through the Swift bridge
// (harness-local/afm/main.swift), returning the NearResult shape every runner
// already reads. The bridge is built on first use and kept running: one
// process, one request at a time, a fresh session per request, as on the phone.
//
// Node-only. Needs macOS with Apple Intelligence on; `afmAvailability()` says
// `modelNotReady` while the model is still downloading.

import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync, mkdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { createInterface } from 'node:readline';

import type { NearResult } from '../lib/near-call';

const SOURCE = resolve(__dirname, '..', 'afm', 'main.swift');
const BINARY = join(homedir(), '.cache', 'mera-harness', 'afm-bridge');

export interface AfmAvailability {
  available: boolean;
  /** null when available, else deviceNotEligible | appleIntelligenceNotEnabled | modelNotReady | unknown. */
  reason: string | null;
  contextSize: number | null;
}

export interface AfmRequest {
  instructions: string;
  prompt: string;
  /** JSON Schema text: guided generation, the reply is the JSON. */
  schema?: string;
  temperature?: number;
  maxTokens?: number;
}

let child: ChildProcessWithoutNullStreams | null = null;
let nextId = 0;
const waiting = new Map<string, (reply: Record<string, unknown>) => void>();
/** One request at a time: the phone holds a lock around the model too. */
let queue: Promise<unknown> = Promise.resolve();

function ensureBuilt(): void {
  if (existsSync(BINARY) && statSync(BINARY).mtimeMs >= statSync(SOURCE).mtimeMs) return;
  mkdirSync(dirname(BINARY), { recursive: true });
  const r = spawnSync('swiftc', ['-O', SOURCE, '-o', BINARY], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`afm bridge build failed (swiftc exit ${r.status}): ${r.stderr.slice(0, 600)}`);
}

function bridge(): ChildProcessWithoutNullStreams {
  if (child) return child;
  ensureBuilt();
  const proc = spawn(BINARY, [], { stdio: ['pipe', 'pipe', 'pipe'] });
  createInterface({ input: proc.stdout }).on('line', (line) => {
    let reply: Record<string, unknown>;
    try {
      reply = JSON.parse(line) as Record<string, unknown>;
    } catch {
      return;
    }
    const id = String(reply.id ?? '');
    waiting.get(id)?.(reply);
    waiting.delete(id);
  });
  proc.on('exit', (code) => {
    child = null;
    for (const resolveReply of waiting.values()) resolveReply({ error: `bridge exited (${code})` });
    waiting.clear();
  });
  // Not unref'd: a pending reply must keep Node alive. Runners end with
  // process.exit or closeAfm().
  child = proc;
  return proc;
}

function send(body: Record<string, unknown>): Promise<Record<string, unknown>> {
  const run = () =>
    new Promise<Record<string, unknown>>((resolveReply) => {
      const id = String(++nextId);
      waiting.set(id, resolveReply);
      bridge().stdin.write(`${JSON.stringify({ ...body, id })}\n`);
    });
  const next = queue.then(run, run);
  queue = next.catch(() => undefined);
  return next;
}

export async function afmAvailability(): Promise<AfmAvailability> {
  const r = await send({ cmd: 'availability' });
  if (typeof r.error === 'string') return { available: false, reason: r.error, contextSize: null };
  return {
    available: r.available === true,
    reason: typeof r.reason === 'string' ? r.reason : null,
    contextSize: typeof r.contextSize === 'number' ? r.contextSize : null,
  };
}

/** One request. `error` is the module's ERR_AFM_* code, or a bridge failure. */
export async function afmCall(req: AfmRequest): Promise<NearResult> {
  const started = Date.now();
  const r = await send({ ...req });
  const error =
    typeof r.error !== 'string' ? null : typeof r.detail === 'string' ? `${r.error}: ${r.detail}` : r.error;
  return {
    content: typeof r.text === 'string' ? r.text : '',
    toolCalls: [],
    finishReason: error ? '-' : 'stop',
    // The framework does not say whether maximumResponseTokens cut the reply.
    truncated: false,
    usage: null,
    modelSent: 'apple-foundation-model',
    latencyMs: Date.now() - started,
    error,
  };
}

/** Ends the bridge so a runner can exit cleanly. */
export function closeAfm(): void {
  child?.stdin.end();
  child = null;
}
