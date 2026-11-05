// Guard: the attestation stub the e2e build bundles (metro.config.js) carries everything
// lib/device-auth.ts imports, and an Android sign-in goes through with it.
import fs from 'fs';
import path from 'path';
import { Platform } from 'react-native';
import * as stub from '@/lib/e2e/device-attest';
import { deviceSignInAvailability, signInWithDevice } from '@/lib/device-auth';

jest.mock('@/modules/mera-device-attest', () => require('@/lib/e2e/device-attest'));

const ROOT = path.resolve(__dirname, '../../..');

describe('e2e device-attest stub', () => {
    it('exports every name device-auth imports from the real module', () => {
        const source = fs.readFileSync(path.join(ROOT, 'lib/device-auth.ts'), 'utf8');
        const block = source.match(/import \{([^}]*)\} from '@\/modules\/mera-device-attest'/);
        const names = block![1].split(',').map((n) => n.trim()).filter(Boolean);
        expect(names.length).toBeGreaterThan(0);
        expect(Object.keys(stub).sort()).toEqual(names.sort());
    });

    it('reaches Get started and signs in on Android', async () => {
        (Platform as { OS: string }).OS = 'android';
        try {
            expect(await deviceSignInAvailability()).toBe('native');
            expect(await signInWithDevice()).toMatchObject({ status: 'success' });
        } finally {
            (Platform as { OS: string }).OS = 'ios';
        }
    });
});
