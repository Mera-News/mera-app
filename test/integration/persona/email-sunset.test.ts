// The email sunset leaves no way into the retired move to phone sign-in (owner bug on 1.3.5: a
// phone that had moved still opened the move dialog from its inbox row). The 1.3.5 row itself is
// hidden by the inbox (NOT_KEPT_NOTICE_TYPES, notification-tap.test.ts), deleted by data-cleanup
// on the first run (data-cleanup.test.ts) and deleted by a tap; this pins that nothing else can
// reach a move: the modules are gone and no screen names an entry point.
import fs from 'node:fs';
import path from 'node:path';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { CLIENT_ROOT } = require('../../../client-resolution') as { CLIENT_ROOT: string };

const ROOT = path.resolve(__dirname, '../../..');

function sources(dir: string): string[] {
    return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) return sources(full);
        return /\.(ts|tsx)$/.test(e.name) ? [full] : [];
    });
}

describe('the retired move to phone', () => {
    it('has no host, flow or Settings entry left to load', () => {
        for (const mod of [
            '@/components/custom/auth/MoveToPhoneHost',
            '@/components/custom/auth/move-to-phone',
            '@/components/custom/auth/email-code-sign-in',
            '@/components/custom/auth/OTPVerificationView',
        ]) {
            expect(() => require(mod)).toThrow(/Could not locate module|Cannot find module/);
        }
    });

    it('no screen or route names a move entry point or its copy', () => {
        const offenders = [
            ...['app', 'components', 'lib'].flatMap((d) => sources(path.join(ROOT, d))),
            ...sources(path.join(CLIENT_ROOT, 'lib')),
        ].filter((file) => {
            const text = fs.readFileSync(file, 'utf8');
            return /requestMoveToPhone|MoveToPhoneHost|settings-row-move-to-phone|['"`]moveToPhone\./.test(text);
        });
        expect(offenders).toEqual([]);
    });
});
