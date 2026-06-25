// REVENUECAT_API_KEY is inlined from .env at transform time (the test key), so
// isRevenueCatEnabled() is true here. Module-level `configured` state is reset
// between tests via jest.resetModules().

const customerInfo = (active: Record<string, unknown> = {}) => ({
  entitlements: { active },
});

const load = () => {
  const rc = require('@/lib/revenuecat');
  const Purchases = require('react-native-purchases').default;
  return { rc, Purchases };
};

describe('revenuecat', () => {
  beforeEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
  });

  describe('getActiveTier', () => {
    it('returns professional when the professional entitlement is active', () => {
      const { rc } = load();
      expect(rc.getActiveTier(customerInfo({ professional: {} }))).toBe(
        'professional',
      );
    });

    it('prefers professional over individual', () => {
      const { rc } = load();
      expect(
        rc.getActiveTier(customerInfo({ professional: {}, individual: {} })),
      ).toBe('professional');
    });

    it('returns individual when only individual is active', () => {
      const { rc } = load();
      expect(rc.getActiveTier(customerInfo({ individual: {} }))).toBe(
        'individual',
      );
    });

    it('returns null when no entitlements are active', () => {
      const { rc } = load();
      expect(rc.getActiveTier(customerInfo())).toBeNull();
      expect(rc.getActiveTier(null)).toBeNull();
    });
  });

  describe('configureRevenueCat', () => {
    it('configures the SDK and marks it configured', () => {
      const { rc, Purchases } = load();
      expect(rc.isRevenueCatConfigured()).toBe(false);
      rc.configureRevenueCat();
      expect(Purchases.configure).toHaveBeenCalledTimes(1);
      expect(rc.isRevenueCatConfigured()).toBe(true);
    });

    it('is a no-op when already configured', () => {
      const { rc, Purchases } = load();
      rc.configureRevenueCat();
      rc.configureRevenueCat();
      expect(Purchases.configure).toHaveBeenCalledTimes(1);
    });
  });

  describe('loginRevenueCat', () => {
    it('returns null when not configured', async () => {
      const { rc, Purchases } = load();
      const result = await rc.loginRevenueCat('user-1');
      expect(result).toBeNull();
      expect(Purchases.logIn).not.toHaveBeenCalled();
    });

    it('returns customerInfo on success', async () => {
      const { rc, Purchases } = load();
      rc.configureRevenueCat();
      Purchases.logIn.mockResolvedValueOnce({
        customerInfo: customerInfo({ individual: {} }),
        created: false,
      });
      const result = await rc.loginRevenueCat('user-1');
      expect(Purchases.logIn).toHaveBeenCalledWith('user-1');
      expect(result).toEqual(customerInfo({ individual: {} }));
    });

    it('returns null on error', async () => {
      const { rc, Purchases } = load();
      rc.configureRevenueCat();
      Purchases.logIn.mockRejectedValueOnce(new Error('boom'));
      expect(await rc.loginRevenueCat('user-1')).toBeNull();
    });
  });

  describe('logoutRevenueCat', () => {
    it('does nothing when not configured', async () => {
      const { rc, Purchases } = load();
      await rc.logoutRevenueCat();
      expect(Purchases.logOut).not.toHaveBeenCalled();
    });

    it('calls logOut when configured', async () => {
      const { rc, Purchases } = load();
      rc.configureRevenueCat();
      await rc.logoutRevenueCat();
      expect(Purchases.logOut).toHaveBeenCalledTimes(1);
    });

    it('swallows logOut errors', async () => {
      const { rc, Purchases } = load();
      rc.configureRevenueCat();
      Purchases.logOut.mockRejectedValueOnce(new Error('anonymous'));
      await expect(rc.logoutRevenueCat()).resolves.toBeUndefined();
    });
  });

  describe('getCustomerInfoSafe', () => {
    it('returns null when not configured', async () => {
      const { rc } = load();
      expect(await rc.getCustomerInfoSafe()).toBeNull();
    });

    it('returns customer info when configured', async () => {
      const { rc, Purchases } = load();
      rc.configureRevenueCat();
      Purchases.getCustomerInfo.mockResolvedValueOnce(
        customerInfo({ professional: {} }),
      );
      expect(await rc.getCustomerInfoSafe()).toEqual(
        customerInfo({ professional: {} }),
      );
    });

    it('returns null on error', async () => {
      const { rc, Purchases } = load();
      rc.configureRevenueCat();
      Purchases.getCustomerInfo.mockRejectedValueOnce(new Error('net'));
      expect(await rc.getCustomerInfoSafe()).toBeNull();
    });
  });

  describe('addCustomerInfoUpdateListener', () => {
    it('returns a no-op unsubscribe when not configured', () => {
      const { rc, Purchases } = load();
      const remove = rc.addCustomerInfoUpdateListener(jest.fn());
      expect(Purchases.addCustomerInfoUpdateListener).not.toHaveBeenCalled();
      expect(() => remove()).not.toThrow();
    });

    it('registers and unregisters the listener when configured', () => {
      const { rc, Purchases } = load();
      rc.configureRevenueCat();
      const cb = jest.fn();
      const remove = rc.addCustomerInfoUpdateListener(cb);
      expect(Purchases.addCustomerInfoUpdateListener).toHaveBeenCalledWith(cb);
      remove();
      expect(Purchases.removeCustomerInfoUpdateListener).toHaveBeenCalledWith(cb);
    });
  });
});
