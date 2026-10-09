// The Mera button's corner, persisted through the real setting service (the in-memory DB) and read
// back with getSetting: hydrate, set, reset. The pure geometry lives in test/unit/chat/.
import {
  DEFAULT_CORNER,
  hydrateMeraButtonCorner,
  MERA_BUTTON_CORNER_KEY,
  resetMeraButtonCorner,
  setMeraCorner,
  useMeraCornerStore,
} from '@/components/custom/mera-button/corner';
import * as settingService from '@/lib/database/services/setting-service';

const { getSetting, setSetting } = settingService;

/** The write is fire-and-forget behind a microtask, so poll the row instead of guessing a tick count. */
async function storedCorner(): Promise<string | null> {
  for (let i = 0; i < 100; i += 1) {
    const value = await getSetting(MERA_BUTTON_CORNER_KEY);
    if (value !== null) return value;
    await new Promise((r) => setTimeout(r, 5));
  }
  return null;
}

const state = () => useMeraCornerStore.getState();

beforeEach(() => resetMeraButtonCorner());

it('starts at the default corner, not yet hydrated', () => {
  expect(DEFAULT_CORNER).toBe('br');
  expect(state()).toMatchObject({ corner: 'br', hydrated: false });
});

it('a set corner shows at once and is the row the next launch reads', async () => {
  setMeraCorner('tr');
  expect(state().corner).toBe('tr');
  expect(await storedCorner()).toBe('tr');

  resetMeraButtonCorner(); // a fresh JS context
  expect(state()).toMatchObject({ corner: 'br', hydrated: false });
  await hydrateMeraButtonCorner();
  expect(state()).toMatchObject({ corner: 'tr', hydrated: true });
});

it('with nothing stored, hydrating keeps bottom right and marks the store hydrated', async () => {
  await hydrateMeraButtonCorner();
  expect(state()).toMatchObject({ corner: 'br', hydrated: true });
});

it.each(['middle', '', 'TL', 'tr '])('a stored %j reads as bottom right', async (garbage) => {
  await setSetting(MERA_BUTTON_CORNER_KEY, garbage);
  await hydrateMeraButtonCorner();
  expect(state()).toMatchObject({ corner: 'br', hydrated: true });
});

it('a failed read still hydrates, at bottom right', async () => {
  await setSetting(MERA_BUTTON_CORNER_KEY, 'tl');
  const spy = jest.spyOn(settingService, 'getSetting').mockRejectedValueOnce(new Error('db'));
  try {
    await hydrateMeraButtonCorner();
  } finally {
    spy.mockRestore();
  }
  expect(state()).toMatchObject({ corner: 'br', hydrated: true });
});

it('hydrates once per JS context, and concurrent calls share the read', async () => {
  await setSetting(MERA_BUTTON_CORNER_KEY, 'bl');
  const first = hydrateMeraButtonCorner();
  expect(hydrateMeraButtonCorner()).toBe(first);
  await first;

  await setSetting(MERA_BUTTON_CORNER_KEY, 'tl');
  await hydrateMeraButtonCorner();
  expect(state().corner).toBe('bl');
});

it('reset (account switch) goes back to bottom right, unhydrated, and the next hydrate re-reads', async () => {
  await setSetting(MERA_BUTTON_CORNER_KEY, 'tl');
  await hydrateMeraButtonCorner();
  expect(state().corner).toBe('tl');

  resetMeraButtonCorner();
  expect(state()).toMatchObject({ corner: 'br', hydrated: false });

  await setSetting(MERA_BUTTON_CORNER_KEY, 'bl');
  await hydrateMeraButtonCorner();
  expect(state()).toMatchObject({ corner: 'bl', hydrated: true });
});

it('a write that fails is swallowed: the button still moves and nothing is thrown', async () => {
  const spy = jest.spyOn(settingService, 'setSetting').mockRejectedValueOnce(new Error('disk full'));
  try {
    setMeraCorner('tl');
    await new Promise((r) => setTimeout(r, 20));
    expect(spy).toHaveBeenCalledWith(MERA_BUTTON_CORNER_KEY, 'tl');
  } finally {
    spy.mockRestore();
  }
  expect(state().corner).toBe('tl');
  expect(await getSetting(MERA_BUTTON_CORNER_KEY)).toBeNull();
});

it('choosing the corner it is already on still writes the row', async () => {
  setMeraCorner('br');
  expect(await storedCorner()).toBe('br');
});
