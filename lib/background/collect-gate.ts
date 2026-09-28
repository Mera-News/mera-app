// "Is a background collect running right now?", for the foreground.
//
// The user can open the app while the OS task is inside step (a), GETting and
// applying the device's waiting batches. The foreground `inference-recover`
// would then poll the same batches. The pipeline's per-batch claim keeps the
// two from applying one batch twice; this gate additionally lets recover wait,
// briefly, for the background collect to finish, so the foreground starts from
// the state the collect wrote rather than racing it.
//
// Dependency-free on purpose: the recover task imports it on every boot.

let active: Promise<void> | null = null;

/** Mark a collect as running until `work` settles. Never rejects. */
export function trackBackgroundCollect<T>(work: Promise<T>): Promise<T> {
  const settled = work.then(
    () => undefined,
    () => undefined,
  );
  active = settled;
  void settled.then(() => {
    if (active === settled) active = null;
  });
  return work;
}

/** Resolve once no background collect is running, or after `maxWaitMs`. */
export async function waitForBackgroundCollect(maxWaitMs: number): Promise<void> {
  const running = active;
  if (!running) return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([
    running,
    new Promise<void>((resolve) => {
      timer = setTimeout(resolve, maxWaitMs);
    }),
  ]);
  if (timer !== undefined) clearTimeout(timer);
}

export function isBackgroundCollectRunning(): boolean {
  return active !== null;
}
