#!/usr/bin/env node
/**
 * ota-publish: every `npm run update:*` goes through here, so no OTA can carry
 * a test-account token.
 *
 *   node scripts/ota-publish.js --channel <name> --environment <eas env> [-- <extra eas update args>]
 *   node scripts/ota-publish.js --scan <dir>     (the leak gate alone; CI uses it)
 *
 * Publish = the export eas-cli would run (iOS and Android, source maps, asset
 * map) under `eas env:exec <env>` with EXPO_NO_DOTENV=1, then the leak gate
 * over `dist`, then `eas update --skip-bundler --input-dir dist --environment
 * <env>`, then the Sentry source-map upload.
 *
 * WHY env:exec: with --skip-bundler, eas-cli applies --environment only to the
 * update's label, never to the bundle. A plain `expo export` would bundle the
 * local .env and drop every EAS-hosted value (prod endpoints, RevenueCat keys,
 * Sentry DSN). So --environment is required, and refused when given twice
 * with different values.
 *
 * The gate refuses the bundle when any file holds the test-token prefix or the
 * value of EXPO_PUBLIC_TEST_ACCOUNT_TOKEN found in this shell or in any local
 * .env* file. It never prints a value, only which needle hit.
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

const EXPORT = 'npx expo export --output-dir dist --source-maps --dump-assetmap --platform ios --platform android';

/** `--environment <v>` pulled out of `args`: the values found and the rest. */
function takeEnvironment(args) {
    const values = [];
    const rest = [];
    for (let i = 0; i < args.length; i++) {
        if (args[i] === '--environment') values.push(args[++i]);
        else if (args[i].startsWith('--environment=')) values.push(args[i].slice('--environment='.length));
        else rest.push(args[i]);
    }
    return { values, rest };
}

function main(argv) {
    const scanAt = argv.indexOf('--scan');
    if (scanAt !== -1) return process.exit(scan(path.resolve(argv[scanAt + 1] || 'dist')));

    const dashes = argv.indexOf('--');
    const own = dashes === -1 ? argv : argv.slice(0, dashes);
    const extraRaw = dashes === -1 ? [] : argv.slice(dashes + 1);
    const channelAt = own.indexOf('--channel');
    const channel = channelAt !== -1 ? own[channelAt + 1] : undefined;
    const ownEnv = takeEnvironment(own).values;
    const { values: extraEnv, rest: extra } = takeEnvironment(extraRaw);
    const envs = [...new Set([...ownEnv, ...extraEnv])];
    if (!channel || envs.length !== 1 || !envs[0]) {
        console.error(
            'usage: ota-publish.js --channel <name> --environment <eas env> [-- <eas update args>] | --scan <dir>\n' +
                '  exactly one --environment is required: it is what puts the EAS variables into the bundle',
        );
        return process.exit(2);
    }
    const environment = envs[0];
    const dist = path.join(ROOT, 'dist');

    fs.rmSync(dist, { recursive: true, force: true });
    run('eas', ['env:exec', environment, `EXPO_NO_DOTENV=1 ${EXPORT}`, '--non-interactive']);
    const verdict = scan(dist);
    if (verdict !== 0) return process.exit(verdict);
    run('eas', ['update', '--skip-bundler', '--input-dir', 'dist', '--channel', channel, '--environment', environment, ...extra]);
    run('npx', ['sentry-expo-upload-sourcemaps', 'dist']);
}

if (require.main === module) main(process.argv.slice(2));

module.exports = { findLeaks, localTokenValues, TOKEN_PREFIX };
