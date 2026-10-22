// The OTA leak gate (scripts/ota-publish.js --scan): a bundle holding a test-account token is
// refused before `eas update` runs. Runs the real script as a child process over temp dirs; the
// publish cases put logging stubs for `eas` and `npx` first on PATH. Also the release notes the
// publish puts into the bundle (EXPO_PUBLIC_OTA_NOTES) and the --message rules.
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const SCRIPT = path.resolve(__dirname, '../../../scripts/ota-publish.js');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { releaseNotes } = require(SCRIPT) as {
    releaseNotes: (m: string, now: string, prior: { at: string; message: string }[]) => { at: string; message: string }[];
};
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
    fs.writeFileSync(path.join(ROOT, 'app.json'), JSON.stringify({ expo: { version: '9.8.7' } }));
    const DIST = path.join(ROOT, 'dist');

    // Two earlier groups and a rollback on the branch, plus a dashed one and one from before the
    // release-notes rule (internal text) that must never ship; the view rows carry the raw message and dates.
    const LIST = {
        currentPage: [
            { group: 'g2', isRollBackToEmbedded: false, message: '"Two" (1 day ago by someone)' },
            { group: 'g-dash', isRollBackToEmbedded: false },
            { group: 'g-rollback', isRollBackToEmbedded: true },
            { group: 'g1', isRollBackToEmbedded: false },
            { group: 'g-legacy', isRollBackToEmbedded: false },
        ],
    };
    const VIEW: Record<string, { createdAt: string; message: string }[]> = {
        g2: [
            { createdAt: '2026-10-25T10:00:00.005Z', message: 'Two' },
            { createdAt: '2026-10-25T10:00:00.001Z', message: 'Two' },
        ],
        'g-dash': [{ createdAt: '2026-10-24T10:00:00.000Z', message: 'Chat \u2014 internal' }],
        g1: [{ createdAt: '2026-10-23T10:00:00.000Z', message: 'One' }],
        'g-legacy': [{ createdAt: '2026-10-22T21:00:00.000Z', message: 'Chat: thinking off, readiness badge' }],
    };

    /** Stub `eas` and `npx` that log their argv; `eas env:exec` writes a clean dist as the export would
     *  and logs the notes it was handed; `update:list` / `update:view` answer from LIST / VIEW. */
    function stubBin(): { bin: string; calls: () => string[][]; notes: () => { at: string; message: string }[] } {
        const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'ota-bin-'));
        const log = path.join(bin, 'calls.jsonl');
        const notesLog = path.join(bin, 'notes.json');
        for (const name of ['eas', 'npx']) {
            const file = path.join(bin, name);
            fs.writeFileSync(
                file,
                `#!${process.execPath}\n` +
                    `const fs = require('fs');\n` +
                    `const args = process.argv.slice(2);\n` +
                    `fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify([${JSON.stringify(name)}, ...args]) + '\\n');\n` +
                    `if (args[0] === 'env:exec') { fs.mkdirSync('dist', { recursive: true }); fs.writeFileSync('dist/bundle.js', 'clean'); fs.writeFileSync(${JSON.stringify(notesLog)}, process.env.EXPO_PUBLIC_OTA_NOTES ?? ''); }\n` +
                    `if (args[0] === 'update:list') process.stdout.write(${JSON.stringify(JSON.stringify(LIST))});\n` +
                    `if (args[0] === 'update:view') process.stdout.write(JSON.stringify(${JSON.stringify(VIEW)}[args[1]]));\n`,
            );
            fs.chmodSync(file, 0o755);
        }
        const calls = () =>
            fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l) as string[]) : [];
        const notes = () => JSON.parse(fs.readFileSync(notesLog, 'utf8')) as { at: string; message: string }[];
        return { bin, calls, notes };
    }
    /** The calls after the release-note reads (one list, one view per kept group). */
    const afterNotes = (calls: string[][]) => calls.filter((c) => c[1] !== 'update:list' && c[1] !== 'update:view');

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
        const [exp, upload, sentry] = afterNotes(calls());
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
        const [exp, upload] = afterNotes(calls());
        expect(exp.slice(0, 3)).toEqual(['eas', 'env:exec', 'preview']);
        expect(upload.filter((a) => a === '--environment')).toHaveLength(1);
    });

    it('reads the earlier notes on the channel branch and runtime and hands them to the export, newest first', () => {
        const { bin, calls, notes } = stubBin();

        const r = publish(bin, ['--channel', 'production', '--environment', 'production', '--', '--message=Faster feed']);

        expect(r.status).toBe(0);
        expect(calls()[0]).toEqual([
            'eas', 'update:list', '--branch', 'production', '--runtime-version', '9.8.7', '--limit', '10', '--json', '--non-interactive',
        ]);
        expect(calls().filter((c) => c[1] === 'update:view').map((c) => c[2])).toEqual(['g2', 'g-dash', 'g1', 'g-legacy']);
        // The fake clock is not used here: "now" is the real time, so it sorts by date, not position.
        const all = notes();
        expect(all.map((n) => n.message).sort()).toEqual(['Faster feed', 'One', 'Two']);
        expect(all.filter((n) => n.message !== 'Faster feed')).toEqual([
            { at: '2026-10-25T10:00:00.001Z', message: 'Two' },
            { at: '2026-10-23T10:00:00.000Z', message: 'One' },
        ]);
    });

    it.each([
        ['no message', []],
        ['an empty message', ['--message', ' ']],
        ['--auto', ['--auto']],
        ['--auto beside a message', ['--auto', '--message', 'x']],
        ['an em dash in the message', ['--message', 'Faster feed \u2014 and more']],
    ])('refuses %s and spawns nothing', (_case, extra) => {
        const { bin, calls } = stubBin();

        const r = publish(bin, ['--channel', 'production', '--environment', 'production', '--', ...extra]);

        expect(r.status).not.toBe(0);
        expect(r.stderr).toContain('--message');
        expect(calls()).toEqual([]);
    });

    it('refuses two different environments', () => {
        const { bin, calls } = stubBin();

        const r = publish(bin, ['--channel', 'production', '--environment', 'production', '--', '--environment', 'preview']);

        expect(r.status).not.toBe(0);
        expect(calls()).toEqual([]);
    });
});

describe('releaseNotes', () => {
    it('puts this update first among the earlier ones, newest first, and drops empty messages', () => {
        const notes = releaseNotes('New', '2026-10-27T09:00:00.000Z', [
            { at: '2026-10-24T09:00:00.000Z', message: 'Old' },
            { at: '2026-10-26T09:00:00.000Z', message: '' },
            { at: '2026-10-25T09:00:00.000Z', message: 'Mid' },
        ]);
        expect(notes.map((n) => n.message)).toEqual(['New', 'Mid', 'Old']);
    });

    it('never ships a prior message from before the release-notes rule, or one with a dash', () => {
        const notes = releaseNotes('New', '2026-10-27T09:00:00.000Z', [
            { at: '2026-10-22T20:00:00.000Z', message: 'Plan MOVE_X: bump' },
            { at: '2026-10-25T09:00:00.000Z', message: 'Feed \u2013 faster' },
            { at: '2026-10-25T10:00:00.000Z', message: 'Kept' },
        ]);
        expect(notes.map((n) => n.message)).toEqual(['New', 'Kept']);
    });
});
