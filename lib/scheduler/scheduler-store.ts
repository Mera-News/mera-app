import { create } from 'zustand';
import type { Job, JobSnapshot, JobStatus, TaskProgress } from './scheduler-types';

interface SchedulerState {
  status: 'initializing' | 'running' | 'paused';

  jobs: Record<string, JobSnapshot>;

  taskCurrentStatus: Record<string, JobStatus | null>;
  taskLastRun: Record<string, number | null>;
  taskProgress: Record<string, TaskProgress | null>;

  runningCount: number;
  failedCount: number;
  pendingCount: number;

  setStatus: (s: SchedulerState['status']) => void;
  addJob: (job: Job) => void;
  setJobRunning: (jobId: string) => void;
  setJobCompleted: (jobId: string, completedAt: number) => void;
  setJobFailed: (jobId: string, exhausted: boolean, retryAt?: number) => void;
  updateProgress: (jobId: string, progress: TaskProgress) => void;
  isRunning: (taskName: string) => boolean;
  getLastRun: (taskName: string) => number | null;
  setLastRun: (taskName: string, ts: number) => void;
  loadLastRunTimes: (times: Record<string, number>) => void;
}

export const useSchedulerStore = create<SchedulerState>((set, get) => ({
  status: 'initializing',
  jobs: {},
  taskCurrentStatus: {},
  taskLastRun: {},
  taskProgress: {},
  runningCount: 0,
  failedCount: 0,
  pendingCount: 0,

  setStatus: (s) => set({ status: s }),

  addJob: (job) =>
    set((state) => ({
      jobs: { ...state.jobs, [job.id]: { ...job } },
      taskCurrentStatus: { ...state.taskCurrentStatus, [job.taskName]: job.status },
      pendingCount: state.pendingCount + 1,
    })),

  setJobRunning: (jobId) =>
    set((state) => {
      const job = state.jobs[jobId];
      if (!job) return state;
      const updated: JobSnapshot = { ...job, status: 'running', startedAt: Date.now() };
      return {
        jobs: { ...state.jobs, [jobId]: updated },
        taskCurrentStatus: { ...state.taskCurrentStatus, [job.taskName]: 'running' },
        runningCount: state.runningCount + 1,
        pendingCount: Math.max(0, state.pendingCount - 1),
      };
    }),

  setJobCompleted: (jobId, completedAt) =>
    set((state) => {
      const job = state.jobs[jobId];
      if (!job) return state;
      const updated: JobSnapshot = { ...job, status: 'completed', completedAt };
      return {
        jobs: { ...state.jobs, [jobId]: updated },
        taskCurrentStatus: { ...state.taskCurrentStatus, [job.taskName]: 'completed' },
        taskLastRun: { ...state.taskLastRun, [job.taskName]: completedAt },
        runningCount: Math.max(0, state.runningCount - 1),
      };
    }),

  setJobFailed: (jobId, exhausted, retryAt) =>
    set((state) => {
      const job = state.jobs[jobId];
      if (!job) return state;
      const status: JobStatus = exhausted ? 'failed' : 'retrying';
      const updated: JobSnapshot = { ...job, status, retryAt };
      return {
        jobs: { ...state.jobs, [jobId]: updated },
        taskCurrentStatus: { ...state.taskCurrentStatus, [job.taskName]: status },
        runningCount: Math.max(0, state.runningCount - 1),
        failedCount: exhausted ? state.failedCount + 1 : state.failedCount,
      };
    }),

  updateProgress: (jobId, progress) =>
    set((state) => {
      const job = state.jobs[jobId];
      if (!job) return state;
      const updated: JobSnapshot = { ...job, progress };
      return {
        jobs: { ...state.jobs, [jobId]: updated },
        taskProgress: { ...state.taskProgress, [job.taskName]: progress },
      };
    }),

  isRunning: (taskName) => get().taskCurrentStatus[taskName] === 'running',

  getLastRun: (taskName) => get().taskLastRun[taskName] ?? null,

  setLastRun: (taskName, ts) =>
    set((state) => ({
      taskLastRun: { ...state.taskLastRun, [taskName]: ts },
    })),

  loadLastRunTimes: (times) =>
    set((state) => ({
      taskLastRun: { ...state.taskLastRun, ...times },
    })),
}));
