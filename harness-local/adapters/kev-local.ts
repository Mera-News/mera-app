// harness-local — Kev on this Mac, through the same C++ the phone runs.
//
// `harness-local/kev/` builds `kev-decide` from node_modules/llama.rn itself: the
// vendored llama.cpp it pins (b11385) and rn-decision.cpp, compiled for Metal, with the
// context the app builds (modelManager.ts initParamsFor: n_ctx 4096, n_batch 4096, flash
// attention, f16 KV). Each request goes through llama_rn_context::decide(), the function
// the phone's context.decide() calls, so the rendering, the pointer readout and the
// temperatures from the GGUF metadata are the phone's. Built with cmake on first use into
// ~/.cache/mera-harness/kev-build, kept running, one request at a time.
//
// `--kev-url <base>` swaps in any TypeSafe /v1/systemone server instead:
//   - brew's `llama-server` on the same GGUF (upstream llama.cpp; matched kev-decide to
//     about 1e-8 on 2026-10-20)
//   - Redpill's cloud kev-4b (full precision, a DIFFERENT number scale from the phone's Q4)
// A labelled fallback, never the default.
//
// Node-only. Needs macOS on Apple silicon, cmake (`brew install cmake`) and the pinned
// GGUF at KEV_MODEL_PATH.

import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync, mkdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import * as dotenv from 'dotenv';

import type { DecisionRequest, DecisionResult } from 'llama.rn';

const CACHE = join(homedir(), '.cache', 'mera-harness');
/** RELEVANCE_MODEL in lib/mera-protocol-toolkit/core/model-catalog.ts, byte size 3,033,489,824. */
export const KEV_MODEL_PATH = join(CACHE, 'models', 'Kev-4B-Q4_K_M.gguf');
const SOURCE_DIR = resolve(__dirname, '..', 'kev');
const BUILD_DIR = join(CACHE, 'kev-build');
const BINARY = join(BUILD_DIR, 'kev-decide');
/** The binary is stale when any of these is newer: our two files, or a new llama.rn. */
const BUILD_INPUTS = [
  join(SOURCE_DIR, 'main.cpp'),
  join(SOURCE_DIR, 'CMakeLists.txt'),
  resolve(__dirname, '..', '..', 'node_modules', 'llama.rn', 'package.json'),
];
const REDPILL_KEV_MODEL = 'jaredpalmer/kev-4b';

export type KevDecide = <R extends DecisionRequest>(request: R) => Promise<DecisionResult<R['questions']>>;

export interface KevBackend {
  /** 'kev-local' (llama.rn's C++ on the Q4 file) or 'kev-url:<base>'. Goes into every report. */
  label: string;
  decide: KevDecide;
  stop(): void;
}

function ensureBuilt(): void {
  const built = existsSync(BINARY) ? statSync(BINARY).mtimeMs : 0;
  if (built && BUILD_INPUTS.every((f) => statSync(f).mtimeMs <= built)) return;
  mkdirSync(BUILD_DIR, { recursive: true });
  for (const args of [
    ['-S', SOURCE_DIR, '-B', BUILD_DIR, '-DCMAKE_BUILD_TYPE=Release'],
    ['--build', BUILD_DIR, '-j', '10'],
  ]) {
    const r = spawnSync('cmake', args, { encoding: 'utf8' });
    if (r.error) throw new Error(`kev-decide build: cmake not found (brew install cmake): ${r.error.message}`);
    if (r.status !== 0) throw new Error(`kev-decide build failed (cmake ${args[0]} exit ${r.status}): ${(r.stderr || r.stdout).slice(-800)}`);
  }
}

/** Starts kev-decide and resolves once the model is loaded. */
export async function startKevLocal(modelPath = KEV_MODEL_PATH): Promise<KevBackend> {
  if (!existsSync(modelPath)) {
    throw new Error(`harness-local: no Kev GGUF at ${modelPath}. See harness-local/README.md, "Kev on this Mac".`);
  }
  ensureBuilt();
  const proc: ChildProcessWithoutNullStreams = spawn(BINARY, [modelPath], { stdio: ['pipe', 'pipe', 'pipe'] });
  const waiting = new Map<string, (reply: Record<string, unknown>) => void>();
  let onReady: ((reply: Record<string, unknown>) => void) | null = null;
  const stderrTail: string[] = [];
  proc.stderr.on('data', (b: Buffer) => {
    stderrTail.push(b.toString());
    if (stderrTail.length > 40) stderrTail.shift();
  });
  // llama.rn logs `[INFO] ...` lines to stdout too; only JSON lines are replies.
  createInterface({ input: proc.stdout }).on('line', (line) => {
    if (!line.startsWith('{')) return;
    let reply: Record<string, unknown>;
    try {
      reply = JSON.parse(line) as Record<string, unknown>;
    } catch {
      return;
    }
    if ('ready' in reply) return onReady?.(reply);
    const id = String(reply.id ?? '');
    waiting.get(id)?.(reply);
    waiting.delete(id);
  });
  let exited = false;
  proc.on('exit', (code) => {
    exited = true;
    const why = { error: `kev-decide exited (${code}): ${stderrTail.join('').slice(-400)}` };
    onReady?.(why);
    for (const r of waiting.values()) r(why);
    waiting.clear();
  });

  const ready = await new Promise<Record<string, unknown>>((r) => (onReady = r));
  if (ready.ready !== true) throw new Error(`kev-decide did not start: ${String(ready.error)}`);

  let nextId = 0;
  // One request at a time, as the phone's llama lock does.
  let queue: Promise<unknown> = Promise.resolve();
  const decide: KevDecide = (request) => {
    const run = () =>
      new Promise<Record<string, unknown>>((r) => {
        if (exited) return r({ error: 'kev-decide is not running' });
        const id = String(++nextId);
        waiting.set(id, r);
        proc.stdin.write(`${JSON.stringify({ id, request })}\n`);
      }).then((reply) => {
        if (typeof reply.error === 'string') throw new Error(reply.error);
        return reply.result as DecisionResult<(typeof request)['questions']>;
      });
    const next = queue.then(run, run);
    queue = next.catch(() => undefined);
    return next;
  };

  return {
    label: 'kev-local',
    decide,
    stop: () => {
      proc.stdin.end();
      proc.kill();
    },
  };
}

/**
 * Any /v1/systemone server. A Redpill base needs REDPILL_API_KEY (harness-local/.env.harness);
 * a local llama-server needs none.
 */
export function kevUrlBackend(baseUrl: string): KevBackend {
  dotenv.config({ path: resolve(__dirname, '..', '.env.harness'), quiet: true });
  const base = baseUrl.replace(/\/$/, '');
  const apiKey = process.env.REDPILL_API_KEY;
  const isRedpill = base.includes('redpill');
  if (isRedpill && !apiKey) throw new Error('harness-local: REDPILL_API_KEY missing (harness-local/.env.harness)');
  const decide: KevDecide = async (request) => {
    const res = await fetch(`${base}/systemone`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(isRedpill ? { Authorization: `Bearer ${apiKey}` } : {}),
      },
      body: JSON.stringify({ ...(isRedpill ? { model: REDPILL_KEV_MODEL } : {}), ...request }),
    });
    if (!res.ok) throw new Error(`kev ${res.status}: ${(await res.text().catch(() => '')).slice(0, 300)}`);
    return (await res.json()) as DecisionResult<(typeof request)['questions']>;
  };
  return { label: `kev-url:${base}`, decide, stop: () => undefined };
}

/** `--kev-url <base>` picks the fallback; otherwise Kev runs locally. */
export function startKev(argv: readonly string[]): Promise<KevBackend> {
  const i = argv.indexOf('--kev-url');
  if (i === -1) return startKevLocal();
  const url = argv[i + 1] ?? '';
  if (!/^https?:\/\//.test(url)) throw new Error(`harness-local: --kev-url needs an http(s) base, got ${JSON.stringify(url)}`);
  return Promise.resolve(kevUrlBackend(url));
}
