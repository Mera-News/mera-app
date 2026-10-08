const mockStore = new Map<string, string>();
jest.mock('@react-native-async-storage/async-storage', () => ({
    __esModule: true,
    default: {
        getItem: async (k: string) => mockStore.get(k) ?? null,
        setItem: async (k: string, v: string) => void mockStore.set(k, v),
        removeItem: async (k: string) => void mockStore.delete(k),
    },
}));

import { setConfirmTopicDelete, shouldConfirmTopicDelete } from '../topic-delete-confirm';

describe('topic delete confirmation', () => {
    beforeEach(() => mockStore.clear());

    it('asks on a device that stored nothing', async () => {
        expect(await shouldConfirmTopicDelete()).toBe(true);
    });

    it("Don't ask again turns it off; the Settings switch turns it back on", async () => {
        await setConfirmTopicDelete(false);
        expect(await shouldConfirmTopicDelete()).toBe(false);
        await setConfirmTopicDelete(true);
        expect(await shouldConfirmTopicDelete()).toBe(true);
    });
});
