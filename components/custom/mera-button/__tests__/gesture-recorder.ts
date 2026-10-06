// A recording stand-in for react-native-gesture-handler in the Mera button
// suites. Every gesture records its config calls and callbacks; GestureDetector
// renders its child and registers the gesture under each test id, so a test can
// drive a handler the way the native side would and assert on the wiring.
// Not a test file (no `.test`), so jest does not run it as a suite.

/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-require-imports */

export interface RecordedGesture {
  kind: string;
  config: Record<string, unknown[]>;
  handlers: Record<string, (...a: any[]) => void>;
  children?: RecordedGesture[];
}

export const detected = new Map<string, RecordedGesture>();

function gesture(kind: string): any {
  const g: RecordedGesture = { kind, config: {}, handlers: {} };
  const chain: any = new Proxy(g, {
    get(target, key: string) {
      if (key in target) return (target as any)[key];
      return (...args: unknown[]) => {
        if (key.startsWith('on')) target.handlers[key] = args[0] as any;
        else target.config[key] = args;
        if (key === 'withTestId') detected.set(String(args[0]), target);
        return chain;
      };
    },
  });
  return chain;
}

export const mock = {
  Gesture: {
    Pan: () => gesture('pan'),
    Tap: () => gesture('tap'),
    Exclusive: (...children: RecordedGesture[]) => ({ kind: 'exclusive', config: {}, handlers: {}, children }),
  },
  GestureDetector: ({ children }: { children: unknown }) => children,
};

/** Drives a recorded pan through start, update(s) and end. */
export function drag(id: string, dx: number, dy: number): void {
  const pan = detected.get(id);
  if (!pan) throw new Error(`no gesture ${id}`);
  pan.handlers.onStart?.({ translationX: 0, translationY: 0 });
  pan.handlers.onUpdate?.({ translationX: dx, translationY: dy });
  pan.handlers.onEnd?.({ translationX: dx, translationY: dy }, true);
  pan.handlers.onFinalize?.({}, true);
}

/** Drives a recorded tap to a successful end. */
export function tap(id: string): void {
  const t = detected.get(id);
  if (!t) throw new Error(`no gesture ${id}`);
  t.handlers.onEnd?.({}, true);
}
