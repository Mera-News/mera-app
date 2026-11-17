// `@/lib/*` resolves to mera-news-client first and the app second. These checks fail when a moved
// module is still answered by an app file (a shadow), when the mapper sends a client module into the
// app, when a client import would load a second copy of a dependency, or when the client's singletons
// are not the ones the app uses.
import fs from 'fs';
import { createRequire } from 'module';
import path from 'path';

const ROOT = path.resolve(__dirname, '../../..');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { CLIENT_ROOT, INSTALLED_CLIENT_ROOT } = require('../../../client-resolution') as {
  CLIENT_ROOT: string;
  INSTALLED_CLIENT_ROOT: string;
};
// eslint-disable-next-line @typescript-eslint/no-require-imports
const clientResolver = require('../../helpers/jest-resolver') as (
  request: string,
  options: Record<string, unknown>,
) => string;

const EXTENSIONS = ['ts', 'tsx', 'js', 'jsx', 'json'];
const PLATFORMS = ['', '.ios', '.android', '.native'];
const FILE = /\.(?:ios\.|android\.|native\.)?(?:ts|tsx|js|jsx|json)$/;
const STEM = /(?:\.(?:ios|android|native))?\.(?:ts|tsx|js|jsx|json)$/;

const real = (p: string) => {
  try {
    return fs.realpathSync(p);
  } catch {
    return p;
  }
};
const inside = (file: string, dir: string) => (real(file) + path.sep).startsWith(real(dir) + path.sep) ||
  real(file).startsWith(real(dir) + path.sep);

/** Every file under `<root>/lib` (relative to `lib`, with `/`), skipping `__tests__`. */
function walk(root: string): string[] {
  const out: string[] = [];
  const visit = (dir: string, rel: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === '__tests__') continue;
      const next = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) visit(path.join(dir, entry.name), next);
      else out.push(next);
    }
  };
  visit(path.join(root, 'lib'), '');
  return out.sort();
}

/**
 * Every app path (relative to the app root) that would answer the same specifier as a client file. A
 * file Metro does not resolve as a module (the harness Markdown, read by path) is shadowed only by
 * the same path.
 */
function answers(rel: string): string[] {
  if (!FILE.test(rel)) return [`lib/${rel}`];
  const stem = rel.replace(STEM, '');
  const stems = [stem, `${stem}/index`];
  if (path.posix.basename(stem) === 'index') stems.push(path.posix.dirname(stem));
  return stems.flatMap((s) =>
    PLATFORMS.flatMap((p) => EXTENSIONS.map((ext) => `lib/${s}${p}.${ext}`)),
  );
}

/** Client files that the app also holds a file for. */
function shadows(clientFiles: string[], appExists: (appPath: string) => boolean) {
  const offenders: string[] = [];
  for (const rel of clientFiles) {
    const hit = answers(rel).find(appExists);
    if (hit) offenders.push(`${hit} shadows lib/${rel}`);
  }
  return offenders;
}

/** Client files whose `@/lib/...` specifier does not resolve inside the client. */
function misresolved(
  clientFiles: string[],
  resolve: (specifier: string) => string,
  clientRoot: string,
) {
  const offenders: string[] = [];
  for (const rel of clientFiles) {
    let found: string;
    try {
      found = resolve(`@/lib/${rel}`);
    } catch {
      offenders.push(`lib/${rel} resolves nowhere`);
      continue;
    }
    if (!inside(found, clientRoot)) offenders.push(`lib/${rel} resolves into the app: ${found}`);
  }
  return offenders;
}

const appHasFile = (appPath: string) => {
  try {
    return fs.statSync(path.join(ROOT, appPath)).isFile();
  } catch {
    return false;
  }
};

// The package's own file set: a copy pointed at by MERA_CLIENT_ROOT must still hold every one.
const clientFiles = walk(INSTALLED_CLIENT_ROOT);
const clientModules = clientFiles.filter((f) => FILE.test(f));

describe('client resolution', () => {
  it('finds the client files', () => {
    expect(clientFiles.length).toBeGreaterThan(100);
    expect(clientFiles.some((f) => f.includes('__tests__'))).toBe(false);
  });

  it('no app file answers a specifier the client ships', () => {
    expect(shadows(clientFiles, appHasFile)).toEqual([]);
  });

  it('every client file resolves inside the client', () => {
    const resolve = (specifier: string) => require.resolve(specifier);
    expect(misresolved(clientModules, resolve, CLIENT_ROOT)).toEqual([]);
  });

  it('a client import of a dependency resolves to the app copy', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(CLIENT_ROOT, 'package.json'), 'utf8')) as {
      dependencies?: Record<string, string>;
      peerDependencies?: Record<string, string>;
    };
    const names = [...Object.keys(pkg.dependencies ?? {}), ...Object.keys(pkg.peerDependencies ?? {})];
    expect(names.length).toBeGreaterThan(0);
    const basedir = path.join(CLIENT_ROOT, 'lib/database');
    const defaultResolver = (request: string, options: { basedir: string }) =>
      createRequire(path.join(options.basedir, 'noop.js')).resolve(request);
    const appModules = path.join(ROOT, 'node_modules');
    const outside = names.filter((name) => {
      const found = clientResolver(name, { basedir, rootDir: ROOT, defaultResolver });
      return !inside(found, appModules);
    });
    expect(outside).toEqual([]);
  });

  it('the client singletons are the ones the app uses', () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { Database } = require('@nozbe/watermelondb');
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const database = require('@/lib/database').default;
    expect(database).toBeInstanceOf(Database);

    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { AppScheduler } = require('@/lib/scheduler/AppScheduler');
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    require('@/lib/scheduler/tasks/data-cleanup-task');
    // A paused task answers 'paused' without running; an unregistered one throws.
    AppScheduler.pauseTask('data-cleanup');
    return expect(AppScheduler.trigger('data-cleanup'))
      .resolves.toBe('paused')
      .finally(() => AppScheduler.resumeTask('data-cleanup'));
  });
});

describe('the checks catch what they guard', () => {
  const files = ['services/scoring-pipeline.ts', 'chat/index.ts', 'ui/icon.ios.tsx', 'harnesses/base/note.md'];

  it('names a planted shadow, including an index and a platform variant', () => {
    const planted = new Set([
      'lib/services/scoring-pipeline.ts',
      'lib/chat/index.js',
      'lib/ui/icon.tsx',
      'lib/harnesses/base/note.md',
    ]);
    expect(shadows(files, (p) => planted.has(p))).toEqual([
      'lib/services/scoring-pipeline.ts shadows lib/services/scoring-pipeline.ts',
      'lib/chat/index.js shadows lib/chat/index.ts',
      'lib/ui/icon.tsx shadows lib/ui/icon.ios.tsx',
      'lib/harnesses/base/note.md shadows lib/harnesses/base/note.md',
    ]);
    expect(shadows(files, () => false)).toEqual([]);
  });

  it('names a client file the mapper sends into the app', () => {
    const resolve = (s: string) =>
      s.endsWith('scoring-pipeline.ts')
        ? path.join(ROOT, 'lib/services/scoring-pipeline.ts')
        : path.join(CLIENT_ROOT, s.replace('@/', ''));
    expect(misresolved(files, resolve, CLIENT_ROOT)).toEqual([
      `lib/services/scoring-pipeline.ts resolves into the app: ${path.join(ROOT, 'lib/services/scoring-pipeline.ts')}`,
    ]);
  });
});
