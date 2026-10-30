// Manage plan > Redeem a code: the store runs offer codes. The purchase hold is taken BEFORE the
// platform call (the sheet or the Play page is a departure). Faked at the edge: the RevenueCat SDK
// (setup mock) and Linking.
import Purchases from 'react-native-purchases';
import { Linking, Platform } from 'react-native';
import { __resetAppRestartForTests, activeHolds } from '@/lib/app-restart';
import { PLAY_REDEEM_URL, redeemOfferCode } from '@/lib/subscription/redeem-code';
import { useFakeClock } from '@/test/helpers';

const presentSheet = (Purchases as unknown as { presentCodeRedemptionSheet: jest.Mock }).presentCodeRedemptionSheet;
const originalOS = Platform.OS;
const setOS = (os: 'ios' | 'android') => Object.defineProperty(Platform, 'OS', { configurable: true, get: () => os });

beforeEach(() => {
    // The hold arms a ceiling timer; a real clock would keep the worker alive.
    useFakeClock(Date.now(), { advanceTimers: true });
    __resetAppRestartForTests();
});
afterEach(() => {
    presentSheet.mockClear();
    Object.defineProperty(Platform, 'OS', { configurable: true, value: originalOS, writable: true });
});

it('iOS presents the code redemption sheet, holding restarts first', async () => {
    setOS('ios');
    let heldAtCall: string[] = [];
    presentSheet.mockImplementationOnce(async () => {
        heldAtCall = activeHolds();
    });
    await redeemOfferCode();
    expect(presentSheet).toHaveBeenCalledTimes(1);
    expect(heldAtCall).toContain('purchase');
});

it('Android opens the Play redeem page, holding restarts first', async () => {
    setOS('android');
    let heldAtCall: string[] = [];
    const open = jest.spyOn(Linking, 'openURL').mockImplementation(async () => {
        heldAtCall = activeHolds();
        return true;
    });
    await redeemOfferCode();
    expect(open).toHaveBeenCalledWith(PLAY_REDEEM_URL);
    expect(presentSheet).not.toHaveBeenCalled();
    expect(heldAtCall).toContain('purchase');
    open.mockRestore();
});

it('never throws when the store refuses', async () => {
    setOS('ios');
    presentSheet.mockRejectedValueOnce(new Error('not configured'));
    await expect(redeemOfferCode()).resolves.toBeUndefined();
    expect(activeHolds()).toContain('purchase');
});
