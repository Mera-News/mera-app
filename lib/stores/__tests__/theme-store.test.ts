const mockGetSetting = jest.fn();
const mockSetSetting = jest.fn();

jest.mock('@/lib/database/services/setting-service', () => ({
  getSetting: (...a: unknown[]) => mockGetSetting(...a),
  setSetting: (...a: unknown[]) => mockSetSetting(...a),
}));

// The jest.mock above must be hoisted before this import, so theme-store never
// reaches the real setting-service.
// eslint-disable-next-line import/first
import { APP_THEME_KEY, resolvePreference, useThemeStore } from '../theme-store';

beforeEach(() => {
  jest.clearAllMocks();
  mockSetSetting.mockResolvedValue(undefined);
  useThemeStore.getState().reset();
});

describe('defaults', () => {
  it('starts dark and unhydrated, so P0 is inert', () => {
    const s = useThemeStore.getState();
    expect(s.preference).toBe('dark');
    expect(s.resolved).toBe('dark');
    expect(s.hydrated).toBe(false);
  });
});

describe('resolvePreference', () => {
  it('passes explicit choices through', () => {
    expect(resolvePreference('light')).toBe('light');
    expect(resolvePreference('dark')).toBe('dark');
  });

  it("resolves 'system' to dark until P6 gives it an OS signal to read", () => {
    // The iOS UIUserInterfaceStyle plist pin blocks Appearance from reporting
    // anything else, so 'system' cannot mean anything but dark yet.
    expect(resolvePreference('system')).toBe('dark');
  });
});

describe('setPreference', () => {
  it('updates resolved and persists under app_theme', async () => {
    await useThemeStore.getState().setPreference('light');
    expect(useThemeStore.getState().preference).toBe('light');
    expect(useThemeStore.getState().resolved).toBe('light');
    expect(mockSetSetting).toHaveBeenCalledWith(APP_THEME_KEY, 'light');
  });

  it('keeps what the user just saw when the write fails', async () => {
    mockSetSetting.mockRejectedValue(new Error('db down'));
    await expect(useThemeStore.getState().setPreference('light')).resolves.toBeUndefined();
    expect(useThemeStore.getState().resolved).toBe('light');
  });
});

describe('hydrateFromDb', () => {
  it('adopts a stored preference', async () => {
    mockGetSetting.mockResolvedValue('light');
    await useThemeStore.getState().hydrateFromDb();
    expect(useThemeStore.getState().resolved).toBe('light');
    expect(useThemeStore.getState().hydrated).toBe(true);
  });

  it('ignores a value that is not a theme and still marks hydrated', async () => {
    mockGetSetting.mockResolvedValue('chartreuse');
    await useThemeStore.getState().hydrateFromDb();
    expect(useThemeStore.getState().preference).toBe('dark');
    expect(useThemeStore.getState().hydrated).toBe(true);
  });

  it('marks hydrated when nothing is stored', async () => {
    mockGetSetting.mockResolvedValue(null);
    await useThemeStore.getState().hydrateFromDb();
    expect(useThemeStore.getState().hydrated).toBe(true);
  });

  it('never fails a launch over a theme', async () => {
    mockGetSetting.mockRejectedValue(new Error('db down'));
    await expect(useThemeStore.getState().hydrateFromDb()).resolves.toBeUndefined();
    expect(useThemeStore.getState().resolved).toBe('dark');
    expect(useThemeStore.getState().hydrated).toBe(true);
  });
});
