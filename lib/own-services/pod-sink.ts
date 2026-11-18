// The writer sink of a paired phone, or undefined. No imports: the app host reads it at every write,
// including a write that lands after a test file was torn down, so reading it must load nothing.
type Sink = (command: { name: string; args: unknown[]; registry: number }) => Promise<unknown>;

let current: Sink | undefined;

export const setPodSink = (sink: Sink | undefined): void => {
  current = sink;
};

export const currentPodSink = (): Sink | undefined => current;
