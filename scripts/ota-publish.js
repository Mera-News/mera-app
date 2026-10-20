#!/usr/bin/env node
/**
 * ota-publish: every `npm run update:*` goes through here, so no OTA can carry
 * a test-account token.
 *
 *   node scripts/ota-publish.js --channel <name> [-- <extra eas update args>]
 *   node scripts/ota-publish.js --scan <dir>     (the leak gate alone; CI uses it)
 *
 * Publish = `expo export` (the same arguments eas-cli would pass: iOS and
 * Android only, source maps, asset map), then the leak gate over `dist`, then
 * `eas update --skip-bundler --input-dir dist`, then the Sentry source-map
 * upload. The gate refuses the bundle when any file holds the test-token
 * prefix or the value of EXPO_PUBLIC_TEST_ACCOUNT_TOKEN found in this shell
 * or in any local .env* file. It never prints a value, only which needle hit.
 *
 * Test-account tokens are read only under __DEV__ (lib/device-auth.ts), so a
 * release export drops them; this gate is what proves it on every publish.
 */
/* global __dirname */
const { Buffer } = require('node:buffer');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const TOKEN_KEY = 'EXPO_PUBLIC_TEST_ACCOUNT_TOKEN';
const TOKEN_PREFIX = 'mera_tsk_';

/** Every local value of the token: this shell, then each .env* file. */
function localTokenValues(root = ROOT, env = process.env) {
    const values = new Set();
    if (env[TOKEN_KEY]) values.add(env[TOKEN_KEY].trim());
    for (const name of fs.readdirSync(root)) {
        if (!name.startsWith('.env')) continue;
        const file = path.join(root, name);
        if (!fs.statSync(file).isFile()) continue;
        for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
            const m = line.match(new RegExp(`^\\s*(?:export\\s+)?${TOKEN_KEY}\\s*=\\s*(.*)$`));
            if (!m) continue;
            const value = m[1].trim().replace(/^(['"])(.*)\1$/, '$2');
            if (value) values.add(value);
        }
    }
    // A value too short to be a token would match by accident; the prefix still guards.
    return [...values].filter((v) => v.length >= 8);
}

function* walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) yield* walk(full);
        else if (entry.isFile()) yield full;
    }
}

/** Files under `dir` holding any needle, as { file, needle } with the needle
 *  named ('prefix' or 'local token value'), never shown. Bytes, not text: the
 *  release bundle is Hermes bytecode, whose string table is plain bytes. */
function findLeaks(dir, tokenValues) {
    const needles = [
        { name: `prefix ${TOKEN_PREFIX}`, bytes: Buffer.from(TOKEN_PREFIX) },
        ...tokenValues.map((v) => ({ name: 'local token value', bytes: Buffer.from(v) })),
    ];
    const leaks = [];
    for (const file of walk(dir)) {
        const buf = fs.readFileSync(file);
        for (const needle of needles) {
            if (buf.includes(needle.bytes)) leaks.push({ file: path.relative(dir, file), needle: needle.name });
        }
    }
    return leaks;
}

/** Exit code 0 when `dir` is clean, 1 (with the offending files) when not. */
function scan(dir) {
    if (!fs.existsSync(dir)) {
        console.error(`ota-publish: ${dir} does not exist`);
        return 2;
    }
    const leaks = findLeaks(dir, localTokenValues());
    if (leaks.length === 0) {
        console.log(`ota-publish: ${dir} holds no test-account token`);
        return 0;
    }
    console.error('ota-publish: REFUSED, the bundle holds a test-account token:');
    for (const { file, needle } of leaks) console.error(`  ${file}: ${needle}`);
    return 1;
}

function run(cmd, args) {
    const r = spawnSync(cmd, args, { cwd: ROOT, stdio: 'inherit' });
    if (r.status !== 0) {
        console.error(`ota-publish: ${cmd} ${args[0]} failed (exit ${r.status ?? r.signal})`);
        process.exit(r.status || 1);
    }
}

function main(argv) {
    const scanAt = argv.indexOf('--scan');
    if (scanAt !== -1) return process.exit(scan(path.resolve(argv[scanAt + 1] || 'dist')));

    const channelAt = argv.indexOf('--channel');
    const channel = channelAt !== -1 ? argv[channelAt + 1] : undefined;
    if (!channel) {
        console.error('usage: ota-publish.js --channel <name> [-- <eas update args>] | --scan <dir>');
        return process.exit(2);
    }
    const dashes = argv.indexOf('--');
    const extra = dashes === -1 ? [] : argv.slice(dashes + 1);
    const dist = path.join(ROOT, 'dist');

    fs.rmSync(dist, { recursive: true, force: true });
    run('npx', ['expo', 'export', '--output-dir', 'dist', '--source-maps', '--dump-assetmap', '--platform', 'ios', '--platform', 'android']);
    const verdict = scan(dist);
    if (verdict !== 0) return process.exit(verdict);
    run('eas', ['update', '--skip-bundler', '--input-dir', 'dist', '--channel', channel, ...extra]);
    run('npx', ['sentry-expo-upload-sourcemaps', 'dist']);
}

if (require.main === module) main(process.argv.slice(2));

module.exports = { findLeaks, localTokenValues, TOKEN_PREFIX };
