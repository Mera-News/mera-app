#!/usr/bin/env node
// Exports a tutorial film as video from the SAME source the app plays
// (tutorials/film/), bundled for react-native-web and recorded frame by frame
// by mera-social's reel.mjs. Run from mera-app:
//
//   node tutorials/export/export-film.mjs --locale en --out <dir>
//   node tutorials/export/export-film.mjs --locale de --out <dir> --no-audio
//   node tutorials/export/export-film.mjs --stills 2400,7000 --out <dir>
//   node tutorials/export/export-film.mjs --promo --out <dir>   (promo-en.mp4: app + store badges end card)
//
// Writes <dir>/welcome-<locale>.mp4 (+ .jpg poster baked in as frame 0),
// or with --stills one PNG per ms and no video. Intermediates go to <dir>/work.
// Needs: mera-social's playwright install (reel.mjs, render.mjs), ffmpeg, python3.

import { build } from 'esbuild';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const app = path.resolve(here, '../..');
const { values: o } = parseArgs({
    options: {
        locale: { type: 'string', default: 'en' },
        out: { type: 'string', default: 'film-out' },
        stills: { type: 'string' },
        promo: { type: 'boolean', default: false },
        'no-audio': { type: 'boolean', default: false },
    },
});
const RTL = new Set(['ar']);
const out = path.resolve(o.out);
const work = path.join(out, 'work');
fs.mkdirSync(work, { recursive: true });

// mera-social sits beside the app checkout at the workspace root (owner checkout or a slot under .worktrees/).
function findCreative() {
    for (let dir = app; dir !== path.dirname(dir); dir = path.dirname(dir)) {
        const c = path.join(dir, 'mera-social/creative');
        if (fs.existsSync(path.join(c, 'reel.mjs'))) return c;
    }
    throw new Error('mera-social/creative/reel.mjs not found above ' + app);
}
const creative = findCreative();

// The script (spans, total) is TypeScript: bundle it for node and import it.
const scriptOut = path.join(work, 'script.mjs');
await build({ entryPoints: [path.join(app, 'tutorials/film/welcome-script.ts')], bundle: true, platform: 'node', format: 'esm', outfile: scriptOut, logLevel: 'error' });
const { WELCOME_SPANS: spans } = await import(pathToFileURL(scriptOut).href);
const total = spans[spans.length - 1].end;

const bundle = path.join(work, 'film.js');
await build({
    entryPoints: [path.join(here, 'entry.tsx')],
    bundle: true,
    outfile: bundle,
    platform: 'browser',
    format: 'iife',
    jsx: 'automatic',
    minify: true,
    logLevel: 'error',
    loader: { '.jpg': 'file', '.svg': 'file' },
    assetNames: '[name]',
    alias: { 'react-native': 'react-native-web', '@expo/vector-icons': path.join(here, 'icons.tsx') },
    resolveExtensions: ['.web.tsx', '.web.ts', '.web.js', '.tsx', '.ts', '.js', '.mjs', '.json'],
    nodePaths: [path.join(app, 'node_modules')],
    define: { 'process.env.NODE_ENV': '"production"', __DEV__: 'false', global: 'window' },
});

const readDict = (loc) => JSON.parse(fs.readFileSync(path.join(app, 'lib/locales', `${loc}.json`), 'utf8'));
const dict = readDict(o.locale);
const fallback = readDict('en');
// Dictionary files are named by region; the app (and its screenshots) by script.
// The promo cut's end card (English only; the app never shows it).
const PROMO_LINE = 'Start <a>for free</a>.';
const APP_CODE = { 'zh-CN': 'zh-Hans', 'zh-TW': 'zh-Hant', 'pt-BR': 'pt' };

function page(name, t0) {
    const input = { dict, fallback, rtl: RTL.has(o.locale), scale: 1, t0, appCode: APP_CODE[o.locale] ?? o.locale, promoLine: o.promo ? PROMO_LINE : undefined };
    const html = `<!doctype html><html lang="${o.locale}" dir="${input.rtl ? 'rtl' : 'ltr'}"><head><meta charset="utf-8">
<link rel="stylesheet" href="https://fonts.googleapis.com/icon?family=Material+Icons">
<style>html,body{margin:0;background:#000}#root{width:1080px;height:1920px}:lang(ko) *{word-break:keep-all}:lang(ja) *{word-break:auto-phrase}</style></head>
<body><div id="root"></div><script>window.FILM_INPUT=${JSON.stringify(input).replace(/</g, '\\u003c')}</script>
<script src="film.js"></script></body></html>`;
    const file = path.join(work, name);
    fs.writeFileSync(file, html);
    return file;
}

const stem = `${o.promo ? 'promo' : 'welcome'}-${o.locale}`;

if (o.stills) {
    for (const ms of o.stills.split(',').map(Number)) {
        const png = path.join(out, `${stem}-${ms}.png`);
        execFileSync('node', [path.join(creative, 'render.mjs'), page(`still-${ms}.html`, ms), png], { stdio: 'inherit' });
    }
    process.exit(0);
}

const audioArgs = [];
if (!o['no-audio']) {
    const wav = path.join(work, `${stem}.wav`);
    execFileSync('python3', [path.join(here, 'score.py'), wav, String(total), spans.map((s) => s.start).join(',')], { stdio: 'inherit' });
    audioArgs.push('--audio', wav);
}

const raw = path.join(work, `${stem}.raw.mp4`);
execFileSync('node', [path.join(creative, 'reel.mjs'), page('film.html', 0), raw, '--seconds', String(total / 1000), '--fps', '30', ...audioArgs], { stdio: 'inherit' });

// Poster: the hook, settled, baked in as frame 0 so a paused player and every feed thumbnail show it.
const poster = path.join(out, `${stem}.jpg`);
const posterAt = 2.5;
execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-ss', String(posterAt), '-i', raw, '-frames:v', '1', '-q:v', '2', poster]);
const mp4 = path.join(out, `${stem}.mp4`);
execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', raw, '-i', poster, '-filter_complex', "[0:v][1:v]overlay=enable='eq(n,0)'[v]",
    '-map', '[v]', '-map', '0:a?', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '18', '-movflags', '+faststart', '-c:a', 'copy', mp4]);
console.log(mp4);
