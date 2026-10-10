import { describeDevice, languageCheckStatus } from '../system-check';

const GB = 1024 * 1024 * 1024;

describe('languageCheckStatus', () => {
    const base = { appLanguage: 'nl', verified: false, blocked: false, isPhysicalDevice: true };

    it('English always passes, even on a simulator', () => {
        expect(languageCheckStatus({ ...base, appLanguage: 'en', isPhysicalDevice: false })).toBe('passed');
    });

    it('a verified pack passes', () => {
        expect(languageCheckStatus({ ...base, verified: true })).toBe('passed');
    });

    it('waits for the startup probe rather than firing its own', () => {
        expect(languageCheckStatus(base)).toBe('checking');
    });

    it('a failed probe leaves only English (no continue anyway)', () => {
        expect(languageCheckStatus({ ...base, blocked: true })).toBe('needs-english');
    });

    it('a simulator or emulator can only continue in English', () => {
        expect(languageCheckStatus({ ...base, verified: true, isPhysicalDevice: false })).toBe('needs-english');
    });
});

describe('describeDevice', () => {
    const memoryLabel = (gb: string) => `${gb} GB memory`;

    it('names model, OS and memory', () => {
        expect(
            describeDevice({ modelName: 'M2101K6G', osName: 'Android', osVersion: '13', totalMemory: 5.7 * GB, memoryLabel }),
        ).toBe('M2101K6G, Android 13, 5.7 GB memory');
    });

    it('leaves out what the OS does not report', () => {
        expect(describeDevice({ modelName: null, osName: 'iOS', osVersion: null, totalMemory: null, memoryLabel })).toBe('iOS');
    });

    it('rounds large memory to whole gigabytes', () => {
        expect(describeDevice({ modelName: null, osName: null, osVersion: null, totalMemory: 12 * GB, memoryLabel })).toBe(
            '12 GB memory',
        );
    });
});
