// Mock the DB-backed settings persistence so the store runs without WatermelonDB.
const mockGetSetting = jest.fn(
  (_key: string): Promise<string | null> => Promise.resolve(null),
);
const mockSetSetting = jest.fn((_key: string, _value: string) => Promise.resolve());
const mockDeleteSetting = jest.fn((_key: string) => Promise.resolve());

jest.mock('@/lib/database/services/setting-service', () => ({
  getSetting: (key: string) => mockGetSetting(key),
  setSetting: (key: string, value: string) => mockSetSetting(key, value),
  deleteSetting: (key: string) => mockDeleteSetting(key),
}));

jest.mock('@/lib/logger', () => ({
  __esModule: true,
  default: {
    captureException: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
    info: jest.fn(),
  },
}));

import { renderHook } from '@testing-library/react-native';
import { ProcessingMode } from '@/lib/generated/graphql-types';
import {
  useOnboardingStore,
  useOnboardingStep,
  useOnboardingPreferences,
  useOnboardingIsInitializing,
  useOnboardingCompletedSteps,
} from '../onboarding-store';
import logger from '@/lib/logger';

describe('useOnboardingStore', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    useOnboardingStore.getState().resetOnboarding();
  });

  it('starts at step 0 with empty preferences', () => {
    const state = useOnboardingStore.getState();
    expect(state.currentStep).toBe(0);
    expect(state.preferences.countries).toEqual([]);
    expect(state.preferences.processingMode).toBe(ProcessingMode.Cloud);
  });

  it('advances and retreats steps within the [0, 3] bounds', () => {
    const { nextStep, prevStep, setStep } = useOnboardingStore.getState();
    setStep(3);
    nextStep(); // clamped at 3
    expect(useOnboardingStore.getState().currentStep).toBe(3);
    setStep(0);
    prevStep(); // clamped at 0
    expect(useOnboardingStore.getState().currentStep).toBe(0);
  });

  it('updates a preference and persists it to the settings service', () => {
    useOnboardingStore.getState().updatePreferences('countries', ['USA', 'FRA']);
    expect(useOnboardingStore.getState().preferences.countries).toEqual([
      'USA',
      'FRA',
    ]);
    expect(mockSetSetting).toHaveBeenCalledWith(
      'onboarding_state',
      expect.stringContaining('USA'),
    );
  });

  it('tracks completed steps without duplicates', () => {
    const { markStepCompleted } = useOnboardingStore.getState();
    markStepCompleted(1);
    markStepCompleted(1);
    markStepCompleted(2);
    expect(useOnboardingStore.getState().completedSteps).toEqual([1, 2]);
  });

  it('resetOnboarding restores defaults and clears persistence', () => {
    useOnboardingStore.getState().updatePreferences('newsImpact', 'high');
    useOnboardingStore.getState().resetOnboarding();
    expect(useOnboardingStore.getState().preferences.newsImpact).toBe('');
    expect(mockDeleteSetting).toHaveBeenCalledWith('onboarding_state');
  });

  it('hydrates persisted preferences from the DB', async () => {
    mockGetSetting.mockResolvedValueOnce(
      JSON.stringify({
        preferences: {
          userId: 'u1',
          countries: ['DEU'],
          newsImpact: 'medium',
          notificationHours: [9],
          processingMode: ProcessingMode.OnDevice,
        },
      }),
    );
    await useOnboardingStore.getState().hydrateFromDb();
    expect(useOnboardingStore.getState().preferences.countries).toEqual(['DEU']);
    expect(useOnboardingStore.getState().preferences.processingMode).toBe(
      ProcessingMode.OnDevice,
    );
  });

  it('keeps defaults when hydration finds nothing', async () => {
    mockGetSetting.mockResolvedValueOnce(null);
    await useOnboardingStore.getState().hydrateFromDb();
    expect(useOnboardingStore.getState().preferences.countries).toEqual([]);
  });

  it('setIsInitializing updates the isInitializing flag', () => {
    useOnboardingStore.getState().setIsInitializing(false);
    expect(useOnboardingStore.getState().isInitializing).toBe(false);
    useOnboardingStore.getState().setIsInitializing(true);
    expect(useOnboardingStore.getState().isInitializing).toBe(true);
  });

  it('hydrateFromDb logs warning on parse error', async () => {
    mockGetSetting.mockResolvedValueOnce('NOT_JSON_AT_ALL{{{');
    await useOnboardingStore.getState().hydrateFromDb();
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('hydrateFromDb failed'),
      expect.objectContaining({ error: expect.any(String) }),
    );
  });

  it('hydrateFromDb falls back to initialPreferences when preferences key is missing', async () => {
    mockGetSetting.mockResolvedValueOnce(JSON.stringify({ other: 'data' }));
    await useOnboardingStore.getState().hydrateFromDb();
    expect(useOnboardingStore.getState().preferences.countries).toEqual([]);
  });

  // ── selector hooks ──────────────────────────────────────────────────────────

  it('useOnboardingStep returns current step', () => {
    useOnboardingStore.getState().setStep(2);
    const { result } = renderHook(() => useOnboardingStep());
    expect(result.current).toBe(2);
  });

  it('useOnboardingPreferences returns current preferences', () => {
    useOnboardingStore.getState().updatePreferences('newsImpact', 'high');
    const { result } = renderHook(() => useOnboardingPreferences());
    expect(result.current.newsImpact).toBe('high');
  });

  it('useOnboardingIsInitializing returns current isInitializing value', () => {
    useOnboardingStore.getState().setIsInitializing(false);
    const { result } = renderHook(() => useOnboardingIsInitializing());
    expect(result.current).toBe(false);
  });

  it('useOnboardingCompletedSteps returns current completedSteps', () => {
    useOnboardingStore.getState().markStepCompleted(3);
    const { result } = renderHook(() => useOnboardingCompletedSteps());
    expect(result.current).toContain(3);
  });
});
