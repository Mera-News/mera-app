// publication-display-store.compiled.test.ts: the display-name hook as the
// app actually runs it, THROUGH THE REACT COMPILER (app.json
// `experiments.reactCompiler`).
//
// Jest does not run the compiler, so the ordinary suites render code the app
// never runs. The compiler memoises any call whose callee is not named `use…`:
// a zustand store called through a binding named `store` was cached on `name`,
// so its hooks ran on the first render and were skipped on the next, and the
// card crashed with a hook-order change ("Cannot read property 'length' of
// undefined"). This suite compiles the real module and renders it for real,
// through failures (a GraphQL validation error, undefined data), empty names,
// and a pending -> failed -> resolved re-render sequence.

/* eslint-disable @typescript-eslint/no-require-imports */
import * as fs from 'fs';
import * as path from 'path';
import { act, render, renderHook } from '@testing-library/react-native';

const SOURCE = path.resolve(__dirname, '../publication-display-store.ts');

/** The module compiled the way Metro compiles it for the app. */
function loadCompiled(): any {
  const babel = require('@babel/core');
  const { code } = babel.transformSync(fs.readFileSync(SOURCE, 'utf8'), {
    filename: SOURCE,
    babelrc: false,
    configFile: false,
    presets: [[require.resolve('@babel/preset-typescript'), { isTSX: true, allExtensions: true }]],
    plugins: [
      [require.resolve('babel-plugin-react-compiler'), {}],
      require.resolve('@babel/plugin-transform-modules-commonjs'),
    ],
  });
  // The compiler really did compile it (a vacuous pass otherwise).
  expect(code).toContain('compiler-runtime');
  const mod = { exports: {} as any };
  const req = (id: string) => {
    if (id === 'react' || id === 'zustand' || id === 'react/compiler-runtime') return require(id);
    throw new Error(`unexpected import ${id}`);
  };
  new Function('require', 'module', 'exports', code)(req, mod, mod.exports);
  return mod.exports;
}

const settle = async (ms = 300) => {
  await act(async () => {
    jest.advanceTimersByTime(ms);
    for (let i = 0; i < 5; i++) await Promise.resolve();
  });
};

/** A GraphQL validation failure as Apollo rejects it (server without the query). */
const validationError = Object.assign(new Error('Cannot query field "publicationDisplayNames" on type "Query".'), {
  graphQLErrors: [{ extensions: { code: 'GRAPHQL_VALIDATION_FAILED' } }],
});

describe('publication display names, compiled by the React Compiler', () => {
  let errors: jest.SpyInstance;
  beforeEach(() => {
    jest.useFakeTimers();
    errors = jest.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => {
    const hookErrors = errors.mock.calls.filter((c) => String(c[0]).includes('order of Hooks'));
    errors.mockRestore();
    jest.useRealTimers();
    expect(hookErrors).toEqual([]);
  });

  function wired(fetch: (lang: string, names: readonly string[]) => Promise<any>) {
    const m = loadCompiled();
    const store = m.usePublicationDisplayStore;
    store.getState().configure({ fetch, load: async () => null, save: async () => {} });
    return { m, store };
  }

  it('keeps the raw name, and re-renders cleanly, when the query fails GraphQL validation', async () => {
    const { m, store } = wired(() => Promise.reject(validationError));
    await act(async () => {
      await store.getState().setLanguage('en');
    });
    const { result, rerender } = renderHook(({ name }: { name: string }) => m.useDisplayPublication(name), {
      initialProps: { name: '人民日报' },
    });
    expect(result.current).toBe('人民日报');
    await settle(); // the call goes out and fails
    rerender({ name: '人民日报' }); // pending -> failed, same name: every hook must still run
    rerender({ name: '人民日报' });
    expect(result.current).toBe('人民日报');
  });

  it('keeps the raw name when the answer has no data', async () => {
    const { m, store } = wired(() => Promise.resolve(undefined));
    await act(async () => {
      await store.getState().setLanguage('en');
    });
    const { result, rerender } = renderHook(({ name }: { name: string }) => m.useDisplayPublication(name), {
      initialProps: { name: 'Le Monde' },
    });
    await settle();
    rerender({ name: 'Le Monde' });
    expect(result.current).toBe('Le Monde');
  });

  it('survives an undefined or empty name, and a name that comes and goes', async () => {
    const { m, store } = wired(() => Promise.resolve({}));
    await act(async () => {
      await store.getState().setLanguage('en');
    });
    const { result, rerender } = renderHook(({ name }: { name?: string }) => m.useDisplayPublication(name), {
      initialProps: { name: undefined as string | undefined },
    });
    expect(result.current).toBeUndefined();
    rerender({ name: '' });
    expect(result.current).toBe('');
    rerender({ name: 'NOS' });
    await settle();
    rerender({ name: undefined });
    rerender({ name: 'NOS' });
    expect(result.current).toBe('NOS');
  });

  it('shows the display name when it lands, across re-renders of the same name', async () => {
    let answer!: (v: Record<string, string>) => void;
    const { m, store } = wired(() => new Promise((r) => (answer = r)));
    await act(async () => {
      await store.getState().setLanguage('en');
    });
    const { result, rerender } = renderHook(({ name }: { name: string }) => m.useDisplayPublication(name), {
      initialProps: { name: '人民日报' },
    });
    await settle();
    rerender({ name: '人民日报' }); // still pending
    await act(async () => {
      answer({ '人民日报': 'Renmin Ribao' });
      for (let i = 0; i < 5; i++) await Promise.resolve();
    });
    expect(result.current).toBe('Renmin Ribao');
    rerender({ name: '人民日报' });
    expect(result.current).toBe('Renmin Ribao');
  });

  it('a list row renders and re-renders through a failure', async () => {
    const { m, store } = wired(() => Promise.reject(validationError));
    await act(async () => {
      await store.getState().setLanguage('en');
    });
    const { Text } = require('react-native');
    const R = require('react');
    const row = (name: string) => R['createElement'](Text, null, R['createElement'](m.DisplayPublicationName, { name }));
    const r = render(row('人民日报'));
    await settle();
    r.rerender(row('人民日报'));
    expect(r.getByText('人民日报')).toBeTruthy();
  });
});
