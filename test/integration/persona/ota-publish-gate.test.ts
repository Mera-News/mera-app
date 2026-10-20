// The OTA leak gate (scripts/ota-publish.js --scan): a bundle holding a test-account token is
// refused before `eas update` runs. Runs the real script as a child process over temp dirs; the
// publish cases put logging stubs for `eas` and `npx` first on PATH.
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

describe('ota-publish --channel', () => {
    // A copy of the script under a temp root: its dist/ and .env* reads stay out of the checkout.
    const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'ota-root-'));
    const COPY = path.join(ROOT, 'scripts', 'ota-publish.js');
    fs.mkdirSync(path.dirname(COPY));
    fs.copyFileSync(SCRIPT, COPY);
    const DIST = path.join(ROOT, 'dist');

    /** Stub `eas` and `npx` that log their argv; `eas env:exec` writes a clean dist as the export would. */
    function stubBin(): { bin: string; calls: () => string[][] } {
        const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'ota-bin-'));
        const log = path.join(bin, 'calls.jsonl');
        for (const name of ['eas', 'npx']) {
            const file = path.join(bin, name);
            fs.writeFileSync(
                file,
                `#!${process.execPath}\n` +
                    `const fs = require('fs');\n` +
                    `const args = process.argv.slice(2);\n` +
                    `fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify([${JSON.stringify(name)}, ...args]) + '\\n');\n` +
                    `if (args[0] === 'env:exec') { fs.mkdirSync('dist', { recursive: true }); fs.writeFileSync('dist/bundle.js', 'clean'); }\n`,
            );
            fs.chmodSync(file, 0o755);
        }
        const calls = () =>
            fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l) as string[]) : [];
        return { bin, calls };
    }

    const publish = (bin: string, args: string[]) =>
        spawnSync(process.execPath, [COPY, ...args], {
            encoding: 'utf8',
            env: { PATH: `${bin}${path.delimiter}${process.env.PATH ?? ''}`, NODE_ENV: 'test' },
        });

    afterEach(() => fs.rmSync(DIST, { recursive: true, force: true }));

    it('refuses a publish with no EAS environment and spawns nothing', () => {
        const { bin, calls } = stubBin();

        const r = publish(bin, ['--channel', 'production', '--', '--message', 'x']);

        expect(r.status).not.toBe(0);
        expect(r.stderr).toContain('--environment');
        expect(calls()).toEqual([]);
    });

    it('bundles under the EAS environment with local .env off, then uploads with the same environment', () => {
        const { bin, calls } = stubBin();

        const r = publish(bin, ['--channel', 'production', '--environment', 'production', '--', '--message', 'x']);

        expect(r.status).toBe(0);
        const [exp, upload, sentry] = calls();
        expect(exp.slice(0, 3)).toEqual(['eas', 'env:exec', 'production']);
        expect(exp[3]).toMatch(/^EXPO_NO_DOTENV=1 npx expo export .*--output-dir dist/);
        expect(exp).toContain('--non-interactive');
        expect(upload).toEqual([
            'eas', 'update', '--skip-bundler', '--input-dir', 'dist',
            '--channel', 'production', '--environment', 'production', '--message', 'x',
        ]);
        expect(sentry).toEqual(['npx', 'sentry-expo-upload-sourcemaps', 'dist']);
    });

    it('takes --environment after -- too, passing it to eas update once', () => {
        const { bin, calls } = stubBin();

        const r = publish(bin, ['--channel', 'preview', '--', '--environment', 'preview', '--message', 'x']);

        expect(r.status).toBe(0);
        expect(calls()[0].slice(0, 3)).toEqual(['eas', 'env:exec', 'preview']);
        expect(calls()[1].filter((a) => a === '--environment')).toHaveLength(1);
    });

    it('refuses two different environments', () => {
        const { bin, calls } = stubBin();

        const r = publish(bin, ['--channel', 'production', '--environment', 'production', '--', '--environment', 'preview']);

        expect(r.status).not.toBe(0);
        expect(calls()).toEqual([]);
    });
});
