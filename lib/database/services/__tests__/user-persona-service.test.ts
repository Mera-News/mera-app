// user-persona-service unit tests
// All WatermelonDB I/O is intercepted via makeDatabaseMock().

jest.mock('@/lib/database/index', () => {
  const { makeDatabaseMock } = require('@/lib/__test-helpers__/mockDatabase');
  return makeDatabaseMock();
});

jest.mock('@/lib/logger', () => ({
  __esModule: true,
  default: { captureException: jest.fn(), captureMessage: jest.fn(), warn: jest.fn() },
}));

import database from '@/lib/database/index';
import { makeRecord } from '@/lib/__test-helpers__/mockDatabase';
import {
  assertPersonaOwner,
  persistUserPersona,
  loadUserPersona,
  clearUserPersona,
} from '../user-persona-service';
import { Q } from '@nozbe/watermelondb';
import logger from '@/lib/logger';
import { OnboardingStage, ProcessingMode } from '@/lib/generated/graphql-types';

const db = database as any;

function makePersonaRecord(overrides: Record<string, unknown> = {}) {
  const createdAt = new Date('2024-01-01T00:00:00Z');
  const updatedAt = new Date('2024-06-01T00:00:00Z');
  return makeRecord({
    id: 'persona-1',
    serverId: 'server-persona-1',
    userId: 'user-1',
    processingMode: ProcessingMode.Cloud,
    onboardingStage: OnboardingStage.Finished,
    blockedByLlm: false,
    blockedByLlmReason: null,
    llmWarningCount: 0,
    notificationsEnabled: true,
    preferredNotificationWindow: [9, 10],
    languageCodes: ['en'],
    createdAt,
    updatedAt,
    ...overrides,
  });
}

function makeServerPersona(overrides: Record<string, unknown> = {}) {
  return {
    _id: 'server-persona-1',
    userId: 'user-1',
    processingMode: ProcessingMode.Cloud,
    onboardingStage: OnboardingStage.Finished,
    blockedByLlm: false,
    blockedByLlmReason: null,
    llmWarningCount: 0,
    notificationsEnabled: true,
    preferredNotificationWindow: [9, 10],
    language_codes: ['en'],
    createdAt: '2024-01-01T00:00:00.000Z',
    updatedAt: '2024-06-01T00:00:00.000Z',
    ...overrides,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  db._setRows('user_personas', []);
});

// ---------------------------------------------------------------------------
// persistUserPersona
// ---------------------------------------------------------------------------

describe('persistUserPersona', () => {
  it('wipes existing personas and creates a new one', async () => {
    const existing = makePersonaRecord({ id: 'old' });
    db._setRows('user_personas', [existing]);

    await persistUserPersona('user-1', makeServerPersona() as any);

    expect(existing.prepareDestroyPermanently).toHaveBeenCalledTimes(1);
    expect(database.write).toHaveBeenCalledTimes(1);
    expect(db._collections['user_personas'].prepareCreate).toHaveBeenCalledTimes(1);
  });

  it('creates correctly when no existing personas exist', async () => {
    db._setRows('user_personas', []);
    await persistUserPersona('user-1', makeServerPersona() as any);
    expect(database.write).toHaveBeenCalledTimes(1);
    expect(db._collections['user_personas'].prepareCreate).toHaveBeenCalledTimes(1);
  });

  it('persists all fields to the created record', async () => {
    db._setRows('user_personas', []);
    const capturedRecord: Record<string, unknown> = {};
    db._collections['user_personas'].prepareCreate.mockImplementationOnce(
      (fn: (r: any) => void) => {
        const rec = makeRecord();
        fn(rec);
        Object.assign(capturedRecord, rec);
        return rec;
      },
    );

    const persona = makeServerPersona({
      _id: 'srv-123',
      notificationsEnabled: false,
      blockedByLlm: true,
      blockedByLlmReason: 'test reason',
      llmWarningCount: 2,
      language_codes: ['en', 'de'],
    });

    await persistUserPersona('user-1', persona as any);
    expect(capturedRecord.serverId).toBe('srv-123');
    expect(capturedRecord.userId).toBe('user-1');
    expect(capturedRecord.blockedByLlm).toBe(true);
    expect(capturedRecord.blockedByLlmReason).toBe('test reason');
    expect(capturedRecord.llmWarningCount).toBe(2);
    expect(capturedRecord.notificationsEnabled).toBe(false);
    expect(capturedRecord.languageCodes).toEqual(['en', 'de']);
  });

  it('handles null blockedByLlmReason', async () => {
    db._setRows('user_personas', []);
    const capturedRecord: Record<string, unknown> = {};
    db._collections['user_personas'].prepareCreate.mockImplementationOnce(
      (fn: (r: any) => void) => {
        const rec = makeRecord();
        fn(rec);
        Object.assign(capturedRecord, rec);
        return rec;
      },
    );

    await persistUserPersona('user-1', makeServerPersona({ blockedByLlmReason: null }) as any);
    expect(capturedRecord.blockedByLlmReason).toBeNull();
  });

  it('handles numeric createdAt / updatedAt timestamps', async () => {
    db._setRows('user_personas', []);
    const capturedRecord: Record<string, unknown> = {};
    db._collections['user_personas'].prepareCreate.mockImplementationOnce(
      (fn: (r: any) => void) => {
        const rec = makeRecord();
        fn(rec);
        Object.assign(capturedRecord, rec);
        return rec;
      },
    );

    const ts = 1700000000000;
    await persistUserPersona(
      'user-1',
      makeServerPersona({ createdAt: ts, updatedAt: ts }) as any,
    );
    expect(capturedRecord.createdAt).toBeInstanceOf(Date);
    expect((capturedRecord.createdAt as Date).getTime()).toBe(ts);
  });

  it('handles Date object timestamps', async () => {
    db._setRows('user_personas', []);
    const capturedRecord: Record<string, unknown> = {};
    db._collections['user_personas'].prepareCreate.mockImplementationOnce(
      (fn: (r: any) => void) => {
        const rec = makeRecord();
        fn(rec);
        Object.assign(capturedRecord, rec);
        return rec;
      },
    );

    const d = new Date('2023-05-10T12:00:00Z');
    await persistUserPersona(
      'user-1',
      makeServerPersona({ createdAt: d, updatedAt: d }) as any,
    );
    expect((capturedRecord.createdAt as Date).getTime()).toBe(d.getTime());
  });

  it('uses Date.now() for invalid string timestamps', async () => {
    db._setRows('user_personas', []);
    const capturedRecord: Record<string, unknown> = {};
    const before = Date.now();
    db._collections['user_personas'].prepareCreate.mockImplementationOnce(
      (fn: (r: any) => void) => {
        const rec = makeRecord();
        fn(rec);
        Object.assign(capturedRecord, rec);
        return rec;
      },
    );

    await persistUserPersona(
      'user-1',
      makeServerPersona({ createdAt: 'not-a-date', updatedAt: 'also-bad' }) as any,
    );
    const after = Date.now();
    const createdTs = (capturedRecord.createdAt as Date).getTime();
    expect(createdTs).toBeGreaterThanOrEqual(before);
    expect(createdTs).toBeLessThanOrEqual(after);
  });

  it('uses Date.now() for null/object timestamps (toTimestamp fallback branch)', async () => {
    db._setRows('user_personas', []);
    const capturedRecord: Record<string, unknown> = {};
    const before = Date.now();
    db._collections['user_personas'].prepareCreate.mockImplementationOnce(
      (fn: (r: any) => void) => {
        const rec = makeRecord();
        fn(rec);
        Object.assign(capturedRecord, rec);
        return rec;
      },
    );

    // Pass null for createdAt/updatedAt — toTimestamp will fall through to the
    // final `return Date.now()` branch (line 118) since null is not number,
    // Date, or string.
    await persistUserPersona(
      'user-1',
      makeServerPersona({ createdAt: null, updatedAt: null }) as any,
    );
    const after = Date.now();
    const createdTs = (capturedRecord.createdAt as Date).getTime();
    expect(createdTs).toBeGreaterThanOrEqual(before);
    expect(createdTs).toBeLessThanOrEqual(after);
  });
});

// ---------------------------------------------------------------------------
// loadUserPersona
// ---------------------------------------------------------------------------

describe('loadUserPersona', () => {
  it('returns null when no persona exists for the user', async () => {
    db._setRows('user_personas', []);
    const result = await loadUserPersona('user-1');
    expect(result).toBeNull();
  });

  it('returns the persona mapped to the UserPersona shape', async () => {
    const createdAt = new Date('2024-01-01T00:00:00Z');
    const updatedAt = new Date('2024-06-01T00:00:00Z');
    const rec = makePersonaRecord({ createdAt, updatedAt });
    db._setRows('user_personas', [rec]);

    const result = await loadUserPersona('user-1');
    expect(result).not.toBeNull();
    expect(result!._id).toBe('server-persona-1');
    expect(result!.userId).toBe('user-1');
    expect(result!.notificationsEnabled).toBe(true);
    expect(result!.createdAt).toBe(createdAt.toISOString());
    expect(result!.updatedAt).toBe(updatedAt.toISOString());
  });

  it('maps ON_DEVICE processingMode correctly', async () => {
    const rec = makePersonaRecord({ processingMode: ProcessingMode.OnDevice });
    db._setRows('user_personas', [rec]);
    const result = await loadUserPersona('user-1');
    expect(result!.processingMode).toBe(ProcessingMode.OnDevice);
  });

  it('defaults unknown processingMode values to Cloud', async () => {
    const rec = makePersonaRecord({ processingMode: 'unknown_mode' });
    db._setRows('user_personas', [rec]);
    const result = await loadUserPersona('user-1');
    expect(result!.processingMode).toBe(ProcessingMode.Cloud);
  });

  it('maps all OnboardingStage values correctly', async () => {
    const stages = [
      OnboardingStage.Finished,
      OnboardingStage.ProcessingMode,
      OnboardingStage.PersonaChat,
      OnboardingStage.Notifications,
    ];
    for (const stage of stages) {
      const rec = makePersonaRecord({ onboardingStage: stage });
      db._setRows('user_personas', [rec]);
      const result = await loadUserPersona('user-1');
      expect(result!.onboardingStage).toBe(stage);
    }
  });

  it('defaults unknown onboardingStage to Notifications', async () => {
    const rec = makePersonaRecord({ onboardingStage: 'UNKNOWN_STAGE' });
    db._setRows('user_personas', [rec]);
    const result = await loadUserPersona('user-1');
    expect(result!.onboardingStage).toBe(OnboardingStage.Notifications);
  });

  it('maps language_codes from languageCodes field', async () => {
    const rec = makePersonaRecord({ languageCodes: ['en', 'fr'] });
    db._setRows('user_personas', [rec]);
    const result = await loadUserPersona('user-1');
    expect(result!.language_codes).toEqual(['en', 'fr']);
  });

  it('uses the first row when multiple records match', async () => {
    const rec1 = makePersonaRecord({ id: 'p1', serverId: 'srv-1' });
    const rec2 = makePersonaRecord({ id: 'p2', serverId: 'srv-2' });
    db._setRows('user_personas', [rec1, rec2]);
    const result = await loadUserPersona('user-1');
    expect(result!._id).toBe('srv-1');
  });
});

// ---------------------------------------------------------------------------
// clearUserPersona
// ---------------------------------------------------------------------------

describe('clearUserPersona', () => {
  it('does not call batch when there are no personas', async () => {
    db._setRows('user_personas', []);
    await clearUserPersona();
    expect(database.batch).not.toHaveBeenCalled();
  });

  it('calls write and batch to delete all personas', async () => {
    const rec = makePersonaRecord();
    db._setRows('user_personas', [rec]);
    await clearUserPersona();
    expect(database.write).toHaveBeenCalledTimes(1);
    expect(database.batch).toHaveBeenCalledTimes(1);
    expect(rec.prepareDestroyPermanently).toHaveBeenCalledTimes(1);
  });

  it('deletes multiple personas in a single batch', async () => {
    const rec1 = makePersonaRecord({ id: 'p1' });
    const rec2 = makePersonaRecord({ id: 'p2' });
    db._setRows('user_personas', [rec1, rec2]);
    await clearUserPersona();
    expect(rec1.prepareDestroyPermanently).toHaveBeenCalledTimes(1);
    expect(rec2.prepareDestroyPermanently).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// assertPersonaOwner — the ownership alarm
// ---------------------------------------------------------------------------
//
// A destructive trigger, so the predicate itself is tested and not only its
// wiring. `user_personas` is the ONLY user-data table with a `user_id` column,
// which makes a foreign row independent evidence of contamination even when
// `cached_user_id` was lost or overwritten — the exact value the cross-user
// leak corrupts.
//
// NOTE ON THE MOCK: the fake `query()` ignores the predicate and counts every
// row set, so the rows here stand for "what the predicate matched". The
// predicate is pinned separately, on the query arguments.

describe('assertPersonaOwner', () => {
  it('asks for rows whose user_id is NOT the owner', () => {
    // If this ever became `Q.eq`, the alarm would invert: it would fire for
    // every correctly-owned device and stay silent on every contaminated one.
    db._setRows('user_personas', []);
    void assertPersonaOwner('user-1');

    expect(db._collections['user_personas'].query).toHaveBeenCalledWith(
      Q.where('user_id', Q.notEq('user-1')),
    );
  });

  it('true, and logs, when a row belongs to somebody else', async () => {
    db._setRows('user_personas', [makePersonaRecord({ userId: 'user-2' })]);

    await expect(assertPersonaOwner('user-1')).resolves.toBe(true);
    expect(logger.captureMessage).toHaveBeenCalledTimes(1);
  });

  it('false when no foreign rows exist', async () => {
    db._setRows('user_personas', []);

    await expect(assertPersonaOwner('user-1')).resolves.toBe(false);
    expect(logger.captureMessage).not.toHaveBeenCalled();
  });

  // IT CAN ONLY CONFIRM, NEVER CLEAR. `persistUserPersona` is called
  // fire-and-forget from the user store, so a perfectly clean device can hold
  // zero persona rows. `false` therefore means "no evidence", never "safe", and
  // no caller may treat it as permission to skip a wipe.
  it('a clean device with zero rows is indistinguishable from no evidence', async () => {
    db._setRows('user_personas', []);
    await expect(assertPersonaOwner('user-1')).resolves.toBe(false);
  });

  it('false rather than throwing when the read fails', async () => {
    // An unanswerable question is not evidence, and this drives a destructive
    // action — it must never fire on a broken read.
    db._collections['user_personas'].query.mockImplementationOnce(() => ({
      fetch: jest.fn(),
      fetchCount: jest.fn(async () => { throw new Error('no such table'); }),
    }));

    await expect(assertPersonaOwner('user-1')).resolves.toBe(false);
  });

  it('false, without querying, for an empty owner id', async () => {
    await expect(assertPersonaOwner('')).resolves.toBe(false);
    expect(db._collections['user_personas'].query).not.toHaveBeenCalled();
  });
});
