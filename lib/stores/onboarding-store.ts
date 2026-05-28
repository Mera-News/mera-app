import { create } from 'zustand';
import { getSetting, setSetting, deleteSetting } from '@/lib/database/services/setting-service';
import { ProcessingMode } from '@/lib/generated/graphql-types';

export interface OnboardingPreferences {
    userId: string;
    countries: string[]; // ISO Alpha-3 country codes
    newsImpact: string;
    notificationHours: number[];
    processingMode: ProcessingMode;
}

interface OnboardingState {
    // Current progress
    currentStep: number; // 0-3
    isInitializing: boolean;

    // User preferences being collected during onboarding
    preferences: OnboardingPreferences;

    // Step completion tracking (for resume capability)
    completedSteps: number[];

    // Actions
    setStep: (step: number) => void;
    nextStep: () => void;
    prevStep: () => void;
    setIsInitializing: (value: boolean) => void;
    updatePreferences: <K extends keyof OnboardingPreferences>(
        key: K,
        value: OnboardingPreferences[K]
    ) => void;
    markStepCompleted: (step: number) => void;
    resetOnboarding: () => void;
    hydrateFromDb: () => Promise<void>;
}

const initialPreferences: OnboardingPreferences = {
    userId: '',
    countries: [],
    newsImpact: '',
    notificationHours: [],
    processingMode: ProcessingMode.Cloud,
};

const initialState = {
    currentStep: 0,
    isInitializing: true,
    preferences: initialPreferences,
    completedSteps: [] as number[],
};

const ONBOARDING_KEY = 'onboarding_state';

// Only `preferences` is persisted now — `currentStep` is derived from the
// server's `onboardingStage` on wizard mount (see OnboardingWizard), and
// `completedSteps` was never used outside the persistence layer.
function persistOnboardingState(state: { preferences: OnboardingPreferences }) {
    setSetting(ONBOARDING_KEY, JSON.stringify(state)).catch(() => {});
}

export const useOnboardingStore = create<OnboardingState>()((set, get) => ({
    ...initialState,

    setStep: (step) => {
        set({ currentStep: step });
    },

    nextStep: () => {
        set((state) => ({ currentStep: Math.min(state.currentStep + 1, 3) }));
    },

    prevStep: () => {
        set((state) => ({ currentStep: Math.max(state.currentStep - 1, 0) }));
    },

    setIsInitializing: (value) => set({ isInitializing: value }),

    updatePreferences: (key, value) => {
        set((state) => ({
            preferences: { ...state.preferences, [key]: value },
        }));
        const s = get();
        persistOnboardingState({ preferences: s.preferences });
    },

    markStepCompleted: (step) => {
        set((state) => ({
            completedSteps: state.completedSteps.includes(step)
                ? state.completedSteps
                : [...state.completedSteps, step],
        }));
    },

    resetOnboarding: () => {
        set(initialState);
        deleteSetting(ONBOARDING_KEY).catch(() => {});
    },

    hydrateFromDb: async () => {
        try {
            const raw = await getSetting(ONBOARDING_KEY);
            if (!raw) return;
            const state = JSON.parse(raw);
            set({
                preferences: state.preferences ?? initialPreferences,
            });
        } catch {
            // Hydration failed — keep defaults
        }
    },
}));

// Selector hooks for optimized subscriptions
export const useOnboardingStep = () =>
    useOnboardingStore((state) => state.currentStep);

export const useOnboardingPreferences = () =>
    useOnboardingStore((state) => state.preferences);

export const useOnboardingIsInitializing = () =>
    useOnboardingStore((state) => state.isInitializing);

export const useOnboardingCompletedSteps = () =>
    useOnboardingStore((state) => state.completedSteps);
