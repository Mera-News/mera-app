#!/usr/bin/env node
/**
 * ota-publish: every `npm run update:*` goes through here, so no OTA can carry
 * a test-account token.
 *
 *   node scripts/ota-publish.js --channel <name> --environment <eas env> [-- <extra eas update args>]
 *   node scripts/ota-publish.js --scan <dir>     (the leak gate alone; CI uses it)
 *
 * Publish = the release notes (below), then the export eas-cli would run (iOS
 * and Android, source maps, asset map) under `eas env:exec <env>` with
 * EXPO_NO_DOTENV=1, then the leak gate over `dist`, then `eas update
 * --skip-bundler --input-dir dist --environment <env>`, then the Sentry
 * source-map upload.
 *
 * RELEASE NOTES: `--message` is required and is text readers see in the app's
 * "What's new" card, so `--auto` (a commit subject) and dashes are refused. The
 * app cannot read an update's message at runtime, nor those of updates it
 * skipped, so the bundle carries them: this message plus the last 10 on the
 * same branch and runtime, as EXPO_PUBLIC_OTA_NOTES (inlined at export, so the
 * export runs with --clear: Metro's cache key ignores env values).
 * `update:list --json` cuts the message and has no date, so each group is read
 * with `update:view --json`.
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

function run(cmd, args, env = process.env) {
    const r = spawnSync(cmd, args, { cwd: ROOT, stdio: 'inherit', env });
    if (r.status !== 0) {
        console.error(`ota-publish: ${cmd} ${args[0]} failed (exit ${r.status ?? r.signal})`);
        process.exit(r.status || 1);
    }
}

/** A command's JSON stdout; any failure stops the publish. */
function runJson(cmd, args) {
    const r = spawnSync(cmd, args, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] });
    if (r.status !== 0) {
        console.error(`ota-publish: ${cmd} ${args[0]} failed (exit ${r.status ?? r.signal})`);
        process.exit(r.status || 1);
    }
    try {
        return JSON.parse(r.stdout);
    } catch {
        console.error(`ota-publish: ${cmd} ${args[0]} printed no JSON`);
        process.exit(1);
    }
}

const EXPORT = 'npx expo export --output-dir dist --source-maps --dump-assetmap --platform ios --platform android --clear';

/** The value of `--message <m>` or `--message=<m>`, or undefined. */
function takeMessage(args) {
    for (let i = 0; i < args.length; i++) {
        if (args[i] === '--message') return args[i + 1];
        if (args[i].startsWith('--message=')) return args[i].slice('--message='.length);
    }
    return undefined;
}

// Messages published before the release-notes rule were internal text (commit
// subjects, plan names) and never reach readers. Move this forward if an update
// is ever published after it without this script.
const NOTES_SINCE = '2026-10-22T23:00:00.000Z';
const DASH = /[\u2013\u2014]/;

/** Text a reader may see: not blank, no dash. */
function readable(message) {
    return typeof message === 'string' && message.trim() !== '' && !DASH.test(message);
}

/** The notes the bundle carries: this update and the readable `prior` ones since NOTES_SINCE, newest first. */
function releaseNotes(message, nowIso, prior) {
    const since = Date.parse(NOTES_SINCE);
    const kept = prior.filter((n) => readable(n.message) && Date.parse(n.at) >= since);
    return [{ at: nowIso, message }, ...kept]
        .filter((n) => readable(n.message) && !Number.isNaN(Date.parse(n.at)))
        .sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
}

/** The last 10 updates' notes on this branch and runtime, rollbacks left out. */
function priorNotes(channel, runtime) {
    // shortcut: branch = channel, switch to eas channel:view --json if they diverge
    const list = runJson('eas', ['update:list', '--branch', channel, '--runtime-version', runtime, '--limit', '10', '--json', '--non-interactive']);
    const groups = (list.currentPage ?? []).filter((g) => !g.isRollBackToEmbedded).map((g) => g.group);
    return groups.map((group) => {
        const rows = runJson('eas', ['update:view', group, '--json']);
        // The earliest platform row: a device's own createdAt is never older, so its own update never shows again.
        const at = rows.map((r) => r.createdAt).sort()[0];
        return { at, message: rows[0]?.message ?? '' };
    });
}

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
    const message = takeMessage(extra);
    if (extra.includes('--auto') || !readable(message)) {
        console.error(
            'ota-publish: --message "<what changed>" is required, readers see it in "What\'s new".\n' +
                '  --auto is refused (a commit subject would reach readers), and so is a dash in the message',
        );
        return process.exit(2);
    }
    const runtime = JSON.parse(fs.readFileSync(path.join(ROOT, 'app.json'), 'utf8')).expo.version;
    const notes = releaseNotes(message, new Date().toISOString(), priorNotes(channel, runtime));
    const dist = path.join(ROOT, 'dist');

    fs.rmSync(dist, { recursive: true, force: true });
    run('eas', ['env:exec', environment, `EXPO_NO_DOTENV=1 ${EXPORT}`, '--non-interactive'], {
        ...process.env,
        EXPO_PUBLIC_OTA_NOTES: JSON.stringify(notes),
    });
    const verdict = scan(dist);
    if (verdict !== 0) return process.exit(verdict);
    run('eas', ['update', '--skip-bundler', '--input-dir', 'dist', '--channel', channel, '--environment', environment, ...extra]);
    run('npx', ['sentry-expo-upload-sourcemaps', 'dist']);
}

if (require.main === module) main(process.argv.slice(2));

module.exports = { findLeaks, localTokenValues, releaseNotes, TOKEN_PREFIX };
