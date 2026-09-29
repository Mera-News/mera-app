import {
    LITE_BELOW_BYTES,
    classifyDevice,
    overrideFromLegacyStaticGradient,
    resolvePerformanceMode,
} from '../performance-mode';

const GB = 1024 * 1024 * 1024;

describe('classifyDevice', () => {
    it('runs Lite below 6 GB (the owner Redmi reports 5.7 GB)', () => {
        expect(classifyDevice(5.7 * GB)).toBe('lite');
        expect(classifyDevice(4 * GB)).toBe('lite');
    });

    it('runs Full at 6 GB and above', () => {
        expect(classifyDevice(LITE_BELOW_BYTES)).toBe('full');
        expect(classifyDevice(8 * GB)).toBe('full');
    });

    it('never reads an unknown reading as a weak phone', () => {
        expect(classifyDevice(null)).toBe('full');
        expect(classifyDevice(undefined)).toBe('full');
        expect(classifyDevice(0)).toBe('full');
        expect(classifyDevice(-1)).toBe('full');
    });
});

describe('resolvePerformanceMode', () => {
    it('auto follows the device', () => {
        expect(resolvePerformanceMode('auto', 'lite')).toBe('lite');
        expect(resolvePerformanceMode('auto', 'full')).toBe('full');
    });

    it('an explicit choice wins over the device', () => {
        expect(resolvePerformanceMode('full', 'lite')).toBe('full');
        expect(resolvePerformanceMode('lite', 'full')).toBe('lite');
    });
});

describe('overrideFromLegacyStaticGradient', () => {
    it('maps the old Static background row onto Lite mode', () => {
        expect(overrideFromLegacyStaticGradient('1')).toBe('lite');
        expect(overrideFromLegacyStaticGradient('0')).toBe('full');
        expect(overrideFromLegacyStaticGradient(null)).toBe('auto');
    });
});
