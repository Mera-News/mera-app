// Stateful stand-ins for the two OS task modules (native edges): `expo-task-manager` and
// `expo-background-task`. The shared setup mocks are inert one-liners with no registry, so the
// reconciler's `getRegisteredTasksAsync` read has nothing to answer. This keeps the registered
// tasks and every register / unregister call, in order. Installed per file with
//   jest.mock('expo-task-manager', () => require('./native-fakes').taskManagerModule);
//   jest.mock('expo-background-task', () => require('./native-fakes').backgroundTaskModule);
export interface RegisteredTask {
  taskName: string;
  options?: { minimumInterval?: number };
}

const registry = new Map<string, RegisteredTask>();
const log: string[] = [];
let status: number | Error = 2;
let refuse: Error | null = null;

/** Values copied from expo-background-task's own enums. */
export const BackgroundTaskStatus = { Restricted: 1, Available: 2 };
export const BackgroundTaskResult = { Success: 1, Failed: 2 };

export const taskManagerModule = {
  defineTask: jest.fn(),
  getRegisteredTasksAsync: async (): Promise<RegisteredTask[]> => [...registry.values()],
  isTaskRegisteredAsync: async (name: string) => registry.has(name),
  unregisterTaskAsync: async (name: string) => {
    registry.delete(name);
  },
};

export const backgroundTaskModule = {
  BackgroundTaskStatus,
  BackgroundTaskResult,
  getStatusAsync: async () => {
    if (status instanceof Error) throw status;
    return status;
  },
  // The real library returns early for a task that is already registered.
  registerTaskAsync: async (name: string, options?: { minimumInterval?: number }) => {
    if (refuse) throw refuse;
    if (registry.has(name)) return;
    log.push(`register:${name}:${options?.minimumInterval}`);
    registry.set(name, { taskName: name, options });
  },
  unregisterTaskAsync: async (name: string) => {
    log.push(`unregister:${name}`);
    registry.delete(name);
  },
};

/** What the OS was asked, in order: `register:<task>:<minutes>` and `unregister:<task>`. */
export const osCalls = (): string[] => [...log];

/** A task the OS already holds, as left by an earlier app version. */
export function preRegister(taskName: string, minimumInterval?: number): void {
  registry.set(taskName, { taskName, options: minimumInterval === undefined ? undefined : { minimumInterval } });
}

export const registeredTasks = (): RegisteredTask[] => [...registry.values()];

export function refuseRegistration(error = new Error('denied')): void {
  refuse = error;
}

export function setBackgroundStatus(next: number | Error): void {
  status = next;
}

/** Back to an empty OS. Call from `beforeEach`. */
export function resetNativeTasks(): void {
  registry.clear();
  log.length = 0;
  status = 2;
  refuse = null;
}
