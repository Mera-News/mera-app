// FD11: a link to the tab screen already on top of that tab's stack keeps it open.
// expo-router (a native edge) is the only mock.
import { router } from 'expo-router';
import { resetCurrentSurface } from '@/components/custom/nav/current-surface';
import { navigateToTabScreen, registerTabStack } from '@/components/custom/nav/navigate-to-page';
import { tabRoute } from '@/components/custom/nav/page-registry';

let unregister: () => void;
const pop = jest.fn();

function openStack(top: { name: string; params: Record<string, unknown> }) {
    unregister = registerTabStack('you', pop, () => top);
}

beforeEach(() => {
    jest.clearAllMocks();
    resetCurrentSurface();
    (router.canDismiss as jest.Mock).mockReturnValue(true);
});
afterEach(() => unregister());

describe('navigateToTabScreen when the screen is already on top', () => {
    it('dismisses the root push and shows the tab, without popping or pushing', () => {
        openStack({ name: 'display', params: {} });
        navigateToTabScreen('you', 'display');
        expect(router.dismissAll).toHaveBeenCalledTimes(1);
        expect(pop).not.toHaveBeenCalled();
        expect(router.push).not.toHaveBeenCalled();
        expect(router.navigate).toHaveBeenCalledWith(tabRoute('you'));
    });

    it('pops and pushes when another screen is on top', () => {
        openStack({ name: 'sources', params: {} });
        navigateToTabScreen('you', 'display');
        expect(pop).toHaveBeenCalledTimes(1);
        expect(router.push).toHaveBeenCalledWith({ pathname: `${tabRoute('you')}/display`, params: {} });
    });

    it('pops and pushes when the params differ', () => {
        openStack({ name: 'display', params: { a: '1' } });
        navigateToTabScreen('you', 'display', { params: { a: '2' } });
        expect(pop).toHaveBeenCalledTimes(1);
        expect(router.push).toHaveBeenCalledTimes(1);
    });
});
