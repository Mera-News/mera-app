import { useOnDeviceBannerStore } from '../on-device-banner-store';

describe('useOnDeviceBannerStore', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        useOnDeviceBannerStore.setState({ visible: false });
    });

    // ── initial state ──────────────────────────────────────────────────────
    it('starts with visible: false', () => {
        expect(useOnDeviceBannerStore.getState().visible).toBe(false);
    });

    // ── show ──────────────────────────────────────────────────────────────
    it('show sets visible to true', () => {
        useOnDeviceBannerStore.getState().show();
        expect(useOnDeviceBannerStore.getState().visible).toBe(true);
    });

    it('show is idempotent', () => {
        useOnDeviceBannerStore.getState().show();
        useOnDeviceBannerStore.getState().show();
        expect(useOnDeviceBannerStore.getState().visible).toBe(true);
    });

    // ── hide ──────────────────────────────────────────────────────────────
    it('hide sets visible to false', () => {
        useOnDeviceBannerStore.getState().show();
        useOnDeviceBannerStore.getState().hide();
        expect(useOnDeviceBannerStore.getState().visible).toBe(false);
    });

    it('hide is idempotent when already hidden', () => {
        useOnDeviceBannerStore.getState().hide();
        expect(useOnDeviceBannerStore.getState().visible).toBe(false);
    });

    // ── toggle via show/hide ──────────────────────────────────────────────
    it('show then hide then show cycles correctly', () => {
        useOnDeviceBannerStore.getState().show();
        expect(useOnDeviceBannerStore.getState().visible).toBe(true);
        useOnDeviceBannerStore.getState().hide();
        expect(useOnDeviceBannerStore.getState().visible).toBe(false);
        useOnDeviceBannerStore.getState().show();
        expect(useOnDeviceBannerStore.getState().visible).toBe(true);
    });
});
