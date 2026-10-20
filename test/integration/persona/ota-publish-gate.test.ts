// The OTA leak gate (scripts/ota-publish.js --scan): a bundle holding a test-account token is
// refused before `eas update` runs. Runs the real script as a child process over temp dirs.
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const SCRIPT = path.resolve(__dirname, '../../../scripts/ota-publish.js');
const CANARY = ['mera', 'tsk', 'ci', 'CANARY'].join('_');

function distWith(files: Record<string, string | Buffer>): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ota-gate-'));
    for (const [name, body] of Object.entries(files)) {
        fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
        fs.writeFileSync(path.join(dir, name), body);
    }
    return dir;
}

const scan = (dir: string, env: Record<string, string> = {}) =>
    spawnSync(process.execPath, [SCRIPT, '--scan', dir], {
        encoding: 'utf8',
        // Only PATH and what the case sets: a token in the developer's shell must not leak in.
        env: { PATH: process.env.PATH ?? '', NODE_ENV: 'test', ...env },
    });

describe('ota-publish --scan', () => {
    it('refuses a dist holding the canary, even inside Hermes-style binary bytes, and never prints it', () => {
        const dir = distWith({
            '_expo/static/js/ios/entry.hbc': Buffer.concat([Buffer.from([0xc6, 0x1f, 0x00]), Buffer.from(CANARY), Buffer.from([0x00])]),
            'metadata.json': '{}',
        });

        const r = scan(dir);

        expect(r.status).toBe(1);
        expect(r.stderr).toContain('_expo/static/js/ios/entry.hbc');
        expect(r.stderr + r.stdout).not.toContain(CANARY);
    });

    it('refuses the local token value even without the prefix', () => {
        const local = 'plain-token-value-1234';
        const dir = distWith({ 'bundle.js': `var t="${local}";` });

        const r = scan(dir, { EXPO_PUBLIC_TEST_ACCOUNT_TOKEN: local });

        expect(r.status).toBe(1);
        expect(r.stderr).toContain('local token value');
        expect(r.stderr + r.stdout).not.toContain(local);
    });

    it('passes a clean dist', () => {
        const dir = distWith({ 'bundle.js': 'var t="/device/nonce";', 'assetmap.json': '{}' });

        expect(scan(dir).status).toBe(0);
    });
});
