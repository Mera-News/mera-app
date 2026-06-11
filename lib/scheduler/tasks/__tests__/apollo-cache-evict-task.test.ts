// Mock evictExpiredApolloCache from apollo-client (side-effectful) BEFORE loading the task file.
// mock-prefixed variables are allowed in jest.mock factories via the babel-jest transform.
const mockEvictExpiredApolloCache = jest.fn();
jest.mock('@/lib/apollo-client', () => ({
    __esModule: true,
    default: {
        query: jest.fn(),
        mutate: jest.fn(),
        cache: { reset: jest.fn(async () => {}), evict: jest.fn(), gc: jest.fn() },
    },
    evictExpiredApolloCache: (...a: any[]) => mockEvictExpiredApolloCache(...a),
}));

// AppScheduler mock — use jest.fn() directly inside the factory (hoisting-safe).
// We'll retrieve the registered task via require after import.
jest.mock('@/lib/scheduler/AppScheduler', () => ({
    AppScheduler: {
        register: jest.fn(),
    },
}));

// Mock logger.
jest.mock('@/lib/logger', () => ({
    __esModule: true,
    default: {
        captureException: jest.fn(),
        captureMessage: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
        debug: jest.fn(),
        info: jest.fn(),
    },
}));

// Importing the task file triggers AppScheduler.register at module load time.
import '../apollo-cache-evict-task';
import { AppScheduler } from '@/lib/scheduler/AppScheduler';

// Capture the registered task definition right after import (before any beforeEach clears it).
// Cast register as jest.Mock to access .mock.calls.
const registerMock = AppScheduler.register as jest.Mock;
const registeredTask: any = registerMock.mock.calls[0]?.[0] ?? null;

// ─────────────────────────────────────────────────────────────────────────────
// apollo-cache-evict-task
// ─────────────────────────────────────────────────────────────────────────────

describe('apollo-cache-evict-task', () => {
    beforeEach(() => {
        // Only reset evictExpiredApolloCache between individual handler tests.
        // Do NOT call jest.clearAllMocks() here as that would clear registerMock
        // and registeredTask was already captured before beforeEach.
        mockEvictExpiredApolloCache.mockReset();
    });

    it('called AppScheduler.register exactly once at module load', () => {
        expect(registerMock).toHaveBeenCalledTimes(1);
    });

    it('registered task is not null', () => {
        expect(registeredTask).not.toBeNull();
    });

    it('registers with the correct name "apollo-cache-evict"', () => {
        expect(registeredTask.name).toBe('apollo-cache-evict');
    });

    it('registers with the correct displayName', () => {
        expect(registeredTask.displayName).toBe('Apollo Cache Eviction');
    });

    it('registers with frequency of 10 minutes (600_000 ms)', () => {
        expect(registeredTask.frequency).toBe(10 * 60 * 1000);
    });

    it('includes "app-foreground" in triggers', () => {
        expect(registeredTask.triggers).toContain('app-foreground');
    });

    it('has no conditions (empty array)', () => {
        expect(registeredTask.conditions).toEqual([]);
    });

    it('has timeout of 5000 ms', () => {
        expect(registeredTask.timeout).toBe(5_000);
    });

    it('has maxAttempts of 1', () => {
        expect(registeredTask.maxAttempts).toBe(1);
    });

    it('has exclusive: false', () => {
        expect(registeredTask.exclusive).toBe(false);
    });

    it('handler calls evictExpiredApolloCache', async () => {
        mockEvictExpiredApolloCache.mockReturnValueOnce(undefined);
        await registeredTask.handler();
        expect(mockEvictExpiredApolloCache).toHaveBeenCalledTimes(1);
    });

    it('handler resolves with undefined', async () => {
        mockEvictExpiredApolloCache.mockReturnValueOnce(undefined);
        await expect(registeredTask.handler()).resolves.toBeUndefined();
    });
});
