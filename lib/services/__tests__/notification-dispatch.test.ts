// notification-dispatch.test.ts

const mockScheduleNotificationAsync = jest.fn();
const mockGetUserStoreState = jest.fn();
const mockGetForYouStoreState = jest.fn();
const mockCaptureException = jest.fn();

jest.mock('expo-notifications', () => ({
  scheduleNotificationAsync: (...args: any[]) => mockScheduleNotificationAsync(...args),
}));

jest.mock('@/lib/stores/user-store', () => ({
  useUserStore: {
    getState: () => mockGetUserStoreState(),
  },
}));

jest.mock('@/lib/stores/for-you-store', () => ({
  useForYouStore: {
    getState: () => mockGetForYouStoreState(),
  },
}));

jest.mock('@/lib/logger', () => ({
  __esModule: true,
  default: {
    captureException: (...args: any[]) => mockCaptureException(...args),
    info: jest.fn(),
    warn: jest.fn(),
  },
}));

import { dispatchResultsNotification } from '../notification-dispatch';

const buildPersona = (overrides: Record<string, any> = {}) => ({
  preferredNotificationWindow: [9, 10, 11],
  notificationsEnabled: true,
  ...overrides,
});

const buildSuggestion = (id: string, reasonGenerationCompleted = true) => ({
  _id: id,
  reasonGenerationCompleted,
});

describe('dispatchResultsNotification', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();
    mockScheduleNotificationAsync.mockResolvedValue('notif-id');
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('returns immediately when userPersona is null', async () => {
    mockGetUserStoreState.mockReturnValue({ userPersona: null });
    mockGetForYouStoreState.mockReturnValue({ suggestions: [] });

    await dispatchResultsNotification({ scoredIds: ['id1'] });

    expect(mockScheduleNotificationAsync).not.toHaveBeenCalled();
  });

  it('returns immediately when readyCount is 0 (no scoredIds with reasonGenerationCompleted)', async () => {
    mockGetUserStoreState.mockReturnValue({ userPersona: buildPersona() });
    mockGetForYouStoreState.mockReturnValue({
      suggestions: [buildSuggestion('id1', false)],
    });

    await dispatchResultsNotification({ scoredIds: ['id1'] });

    expect(mockScheduleNotificationAsync).not.toHaveBeenCalled();
  });

  it('returns immediately when notifications are disabled', async () => {
    mockGetUserStoreState.mockReturnValue({
      userPersona: buildPersona({ notificationsEnabled: false }),
    });
    mockGetForYouStoreState.mockReturnValue({
      suggestions: [buildSuggestion('id1', true)],
    });

    await dispatchResultsNotification({ scoredIds: ['id1'] });

    expect(mockScheduleNotificationAsync).not.toHaveBeenCalled();
  });

  it('schedules a notification when current UTC hour is in the preference window', async () => {
    const hourInWindow = 10;
    jest.setSystemTime(new Date(Date.UTC(2024, 0, 1, hourInWindow, 30, 0)));

    mockGetUserStoreState.mockReturnValue({
      userPersona: buildPersona({ preferredNotificationWindow: [hourInWindow] }),
    });
    mockGetForYouStoreState.mockReturnValue({
      suggestions: [buildSuggestion('id1', true), buildSuggestion('id2', true)],
    });

    await dispatchResultsNotification({ scoredIds: ['id1', 'id2'] });

    expect(mockScheduleNotificationAsync).toHaveBeenCalledWith({
      content: {
        title: '2 articles to process',
        body: 'Open Mera to see what impacts you.',
        data: { type: 'inference-done-local' },
      },
      trigger: null,
    });
  });

  it('uses singular "article" when readyCount is 1', async () => {
    const hourInWindow = 10;
    jest.setSystemTime(new Date(Date.UTC(2024, 0, 1, hourInWindow, 0, 0)));

    mockGetUserStoreState.mockReturnValue({
      userPersona: buildPersona({ preferredNotificationWindow: [hourInWindow] }),
    });
    mockGetForYouStoreState.mockReturnValue({
      suggestions: [buildSuggestion('id1', true)],
    });

    await dispatchResultsNotification({ scoredIds: ['id1'] });

    expect(mockScheduleNotificationAsync).toHaveBeenCalledWith(
      expect.objectContaining({
        content: expect.objectContaining({ title: '1 article to process' }),
      }),
    );
  });

  it('does NOT schedule when current UTC hour is outside the preference window', async () => {
    const hourOutOfWindow = 23;
    jest.setSystemTime(new Date(Date.UTC(2024, 0, 1, hourOutOfWindow, 0, 0)));

    mockGetUserStoreState.mockReturnValue({
      userPersona: buildPersona({ preferredNotificationWindow: [9, 10, 11] }),
    });
    mockGetForYouStoreState.mockReturnValue({
      suggestions: [buildSuggestion('id1', true)],
    });

    await dispatchResultsNotification({ scoredIds: ['id1'] });

    expect(mockScheduleNotificationAsync).not.toHaveBeenCalled();
  });

  it('handles empty preferredNotificationWindow gracefully', async () => {
    mockGetUserStoreState.mockReturnValue({
      userPersona: buildPersona({ preferredNotificationWindow: [] }),
    });
    mockGetForYouStoreState.mockReturnValue({
      suggestions: [buildSuggestion('id1', true)],
    });

    await dispatchResultsNotification({ scoredIds: ['id1'] });

    expect(mockScheduleNotificationAsync).not.toHaveBeenCalled();
  });

  it('handles null preferredNotificationWindow (uses empty array default)', async () => {
    mockGetUserStoreState.mockReturnValue({
      userPersona: buildPersona({ preferredNotificationWindow: null }),
    });
    mockGetForYouStoreState.mockReturnValue({
      suggestions: [buildSuggestion('id1', true)],
    });

    await dispatchResultsNotification({ scoredIds: ['id1'] });

    expect(mockScheduleNotificationAsync).not.toHaveBeenCalled();
  });

  it('silently captures exceptions from scheduleNotificationAsync', async () => {
    const hourInWindow = 10;
    jest.setSystemTime(new Date(Date.UTC(2024, 0, 1, hourInWindow, 0, 0)));

    const scheduleError = new Error('notification error');
    mockScheduleNotificationAsync.mockRejectedValue(scheduleError);

    mockGetUserStoreState.mockReturnValue({
      userPersona: buildPersona({ preferredNotificationWindow: [hourInWindow] }),
    });
    mockGetForYouStoreState.mockReturnValue({
      suggestions: [buildSuggestion('id1', true)],
    });

    // Should not throw
    await expect(
      dispatchResultsNotification({ scoredIds: ['id1'] }),
    ).resolves.toBeUndefined();

    expect(mockCaptureException).toHaveBeenCalledWith(scheduleError, expect.objectContaining({
      tags: expect.objectContaining({ service: 'notification-dispatch' }),
    }));
  });

  it('only counts scoredIds that have reasonGenerationCompleted=true in suggestions map', async () => {
    const hourInWindow = 10;
    jest.setSystemTime(new Date(Date.UTC(2024, 0, 1, hourInWindow, 0, 0)));

    mockGetUserStoreState.mockReturnValue({
      userPersona: buildPersona({ preferredNotificationWindow: [hourInWindow] }),
    });
    // id1 has reason completed, id2 does not, id3 is not in suggestions map
    mockGetForYouStoreState.mockReturnValue({
      suggestions: [
        buildSuggestion('id1', true),
        buildSuggestion('id2', false),
      ],
    });

    await dispatchResultsNotification({ scoredIds: ['id1', 'id2', 'id3'] });

    expect(mockScheduleNotificationAsync).toHaveBeenCalledWith(
      expect.objectContaining({
        content: expect.objectContaining({ title: '1 article to process' }),
      }),
    );
  });

  it('does not schedule when scoredIds is empty', async () => {
    mockGetUserStoreState.mockReturnValue({ userPersona: buildPersona() });
    mockGetForYouStoreState.mockReturnValue({ suggestions: [] });

    await dispatchResultsNotification({ scoredIds: [] });

    expect(mockScheduleNotificationAsync).not.toHaveBeenCalled();
  });
});
