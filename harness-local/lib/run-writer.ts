// Node-only run recorder for the harness-local scripts. Writes each artifact of
// a harness run into a timestamped directory under .local-test-data/runs/ so
// runs are inspectable + diffable after the fact.

import { execSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { defaultRunsRoot as defaultLocalDataRunsRoot } from '../config/local-data';

export interface RunWriter {
  dir: string;
  writeJson(name: string, data: unknown): void;
  finish(summary: Record<string, unknown>): void;
}

/** Best-effort HEAD sha; tolerates being run outside a git tree. */
export function captureGitSha(): string | null {
  try {
    return execSync('git rev-parse HEAD', {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return null;
  }
}

function timestamp(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return (
    `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}` +
    `-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
  );
}

export function createRunWriter(opts: {
  label: string;
  runsRoot?: string;
}): RunWriter {
  const runsRoot = opts.runsRoot ?? defaultLocalDataRunsRoot();
  const safeLabel = opts.label.replace(/[^a-zA-Z0-9._-]+/g, '-') || 'run';
  const dir = join(runsRoot, `${timestamp()}-${safeLabel}`);
  mkdirSync(dir, { recursive: true });

  const writeJson = (name: string, data: unknown): void => {
    const file = name.endsWith('.json') ? name : `${name}.json`;
    writeFileSync(join(dir, file), `${JSON.stringify(data, null, 2)}\n`, 'utf8');
  };

  return {
    dir,
    writeJson,
    finish(summary: Record<string, unknown>): void {
      writeJson('summary', { gitSha: captureGitSha(), ...summary });
      // eslint-disable-next-line no-console
      console.log(`\nRun written to: ${dir}`);
    },
  };
}
