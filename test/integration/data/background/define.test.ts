// `define-tasks.ts` is two `defineTask` calls, evaluated at bundle load before the router exists.
// Required in a fresh module registry, it must define both OS tasks on the task-manager edge, and the
// `mera-background` body must be the wake. `jest.isolateModules` is the process start: the shared
// registry already holds the module state (`defined`) that a second load would skip.
jest.mock('expo-task-manager', () => require('./native-fakes').taskManagerModule);
jest.mock('expo-background-task', () => require('./native-fakes').backgroundTaskModule);

jest.setTimeout(60_000);

type Body = (...args: unknown[]) => Promise<unknown>;

function startProcess(): { defined: [string, Body][]; success: unknown } {
  let defined: [string, Body][] = [];
  let success: unknown;
  jest.isolateModules(() => {
    require('@/lib/background/define-tasks');
    const tm = require('expo-task-manager');
    defined = (tm.defineTask as jest.Mock).mock.calls.map((c) => [c[0], c[1]]);
    success = require('expo-background-task').BackgroundTaskResult.Success;
  });
  return { defined, success };
}

describe('define-tasks', () => {
  it('defines mera-background and the inference task, once each', () => {
    const { defined } = startProcess();

    expect(defined.map(([name]) => name).sort()).toEqual(['mera-background', 'mera-inference-task']);
  });

  it('the mera-background body is the wake: it runs headless and reports success', async () => {
    const { defined, success } = startProcess();
    const body = defined.find(([name]) => name === 'mera-background')![1];

    // A fresh process with an empty device: the refresh stops at a signed-out keychain.
    await expect(body()).resolves.toBe(success);
  });
});
