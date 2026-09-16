// The asset contract, as a repo gate rather than a ritual.
//
// `scripts/animations/validate.py` is the full check and it decides things this
// cannot cheaply (the frame-by-frame bounding-box sweep, seam closure per
// animated property). What lives here is the subset that must never regress
// without a test going red: the files the three registries `require()` exist,
// and every file in the directory still meets the mechanical lines of the
// contract.
//
// Metro resolves `require()` at BUNDLE time, so a registry entry pointing at a
// missing file is a build error no runtime guard can catch. This turns that
// into a test failure with a filename in it instead.
import fs from 'fs';
import path from 'path';

import { PROCESSING_ANIMATIONS } from '../animation-registry';
import {
  GAME_ANIMATIONS,
  GAME_LOOP_IDS,
  GAME_REWARD_IDS,
} from '@/components/custom/game-ui/animation-registry';
import {
  EXPLICIT_ANIMATION_IDS,
  TUTORIAL_ANIMATIONS,
} from '@/components/custom/tutorials/animation-registry';
import { PROCESSING_STAGES } from '../processing-stages';
import { PROCESSING_STAGE_IDS } from '../types';

const REPO_ROOT = path.resolve(__dirname, '../../../..');
const ASSET_DIR = path.join(REPO_ROOT, 'assets/animations');

const ACCENT = [231 / 255, 138 / 255, 83 / 255];
const MAX_BYTES = 150 * 1024;

// Mirrors ONE_SHOT_IDS in scripts/animations/validate.py. A one-shot plays once
// and stops, so the loop contract's 2.0-4.0 s band does not describe it; it is
// held to 0.3-2.0 s instead, checked separately below.
//
// DERIVED from the kit registry's `GAME_REWARD_IDS` rather than retyped,
// because that array is also what the `GameRewardId` type is pinned to. One
// list, three readers: the type, this gate, and validate.py. Only the Python
// copy is a hand-kept mirror, and it is the one a `tsc` run cannot reach.
//
// An id in NEITHER list is validated as a loop and fails loud on duration, in
// both languages. That is the designed failure: forgetting to declare a new
// one-shot cannot silently pass under the relaxed band.
const ONE_SHOT_IDS = new Set<string>(GAME_REWARD_IDS);
const ONE_SHOT_LO = 0.3;
const ONE_SHOT_HI = 2.0;

interface Bodymovin {
  w: number;
  h: number;
  fr: number;
  op: number;
  assets: unknown[];
  layers: { ty: number; nm?: string; shapes?: unknown[] }[];
}

const assetFiles = () =>
  fs.readdirSync(ASSET_DIR).filter((f) => f.endsWith('.json'));

const read = (file: string): Bodymovin =>
  JSON.parse(fs.readFileSync(path.join(ASSET_DIR, file), 'utf8')) as Bodymovin;

describe('animation assets — the registries point at real files', () => {
  it('the registry covers every stage id', () => {
    // `stageDef` throws on a miss and its comment calls that unreachable. This
    // is what makes that true.
    expect(PROCESSING_STAGES.map((s) => s.id)).toEqual([...PROCESSING_STAGE_IDS]);
  });

  it('has a processing animation for every stage id', () => {
    expect(Object.keys(PROCESSING_ANIMATIONS).sort()).toEqual([...PROCESSING_STAGE_IDS].sort());
  });

  it.each([...PROCESSING_STAGE_IDS])('has processing-%s.json on disk', (stage) => {
    expect(fs.existsSync(path.join(ASSET_DIR, `processing-${stage}.json`))).toBe(true);
  });

  // The tutorials registry holds TWO families now: one derived hero per chapter
  // (`<chapter>-<slide>`), and the gesture hint loops, which are not slides and
  // so carry explicit ids. Counting the whole map would have to be edited every
  // time a non-hero piece lands, which is how a count assertion stops meaning
  // anything; the per-chapter rule is what matters and it is asserted directly.
  it('has exactly one tutorial hero per chapter, all twelve on disk', () => {
    const heroes = Object.keys(TUTORIAL_ANIMATIONS).filter(
      (id) => !EXPLICIT_ANIMATION_IDS.includes(id as never),
    );
    expect(heroes).toHaveLength(12);
    for (const id of heroes) {
      expect(fs.existsSync(path.join(ASSET_DIR, `${id}.json`))).toBe(true);
    }
  });

  it('has every explicitly-claimed tutorial piece on disk', () => {
    expect(EXPLICIT_ANIMATION_IDS.length).toBeGreaterThan(0);
    for (const id of EXPLICIT_ANIMATION_IDS) {
      expect(fs.existsSync(path.join(ASSET_DIR, `${id}.json`))).toBe(true);
    }
  });

  // Both directions, because each catches a different mistake. A missing FILE
  // is a Metro build error at bundle time, which no runtime guard can catch. A
  // missing ENTRY is quieter and worse: the asset ships in the bundle, nothing
  // can resolve it, and it reads as a stray to the orphan check below.
  it('has every game registry entry on disk', () => {
    for (const id of Object.keys(GAME_ANIMATIONS)) {
      expect(fs.existsSync(path.join(ASSET_DIR, `${id}.json`))).toBe(true);
    }
  });

  it('claims every game- file on disk in the registry', () => {
    const onDisk = assetFiles()
      .filter((f) => f.startsWith('game-'))
      .map((f) => f.replace(/\.json$/, ''));
    expect(onDisk.sort()).toEqual(Object.keys(GAME_ANIMATIONS).sort());
  });

  // The reward/loop split is by MEASURED duration, and the one-shot band was
  // written for a different reason (the asset contract) yet agrees with it
  // independently. That agreement is what makes the split worth asserting
  // rather than commenting: a loop routed through a one-shot host plays once,
  // wrong.
  it('splits reward ids from loop ids by measured duration, with no overlap', () => {
    const rewards = new Set<string>(GAME_REWARD_IDS);
    for (const id of GAME_LOOP_IDS) {
      expect(rewards.has(id)).toBe(false);
      const doc = read(`${id}.json`);
      expect(doc.op / doc.fr).toBeGreaterThan(ONE_SHOT_HI);
    }
    expect([...GAME_REWARD_IDS, ...GAME_LOOP_IDS].sort()).toEqual(
      Object.keys(GAME_ANIMATIONS).sort(),
    );
  });

  it('leaves no orphan in the directory that no registry claims', () => {
    const claimed = new Set([
      ...PROCESSING_STAGE_IDS.map((s) => `processing-${s}.json`),
      ...Object.keys(TUTORIAL_ANIMATIONS).map((id) => `${id}.json`),
      ...Object.keys(GAME_ANIMATIONS).map((id) => `${id}.json`),
    ]);
    expect(assetFiles().filter((f) => !claimed.has(f))).toEqual([]);
  });
});

describe('animation assets — the mechanical contract lines', () => {
  it('every file parses as bodymovin', () => {
    for (const file of assetFiles()) expect(() => read(file)).not.toThrow();
  });

  it('every canvas is 1000 x 1000', () => {
    for (const file of assetFiles()) {
      const doc = read(file);
      expect([file, doc.w, doc.h]).toEqual([file, 1000, 1000]);
    }
  });

  it('every loop is between 2 and 4 seconds', () => {
    for (const file of assetFiles()) {
      const id = file.replace(/\.json$/, '');
      if (ONE_SHOT_IDS.has(id)) continue; // checked separately, below
      const doc = read(file);
      const seconds = doc.op / doc.fr;
      expect(seconds).toBeGreaterThanOrEqual(2);
      expect(seconds).toBeLessThanOrEqual(4);
    }
  });

  it('every declared one-shot is between 0.3 and 2.0 seconds', () => {
    // Non-vacuity: the band is only meaningful if something is in it. An empty
    // ONE_SHOT_IDS would make the loop check above cover everything and this
    // one assert nothing, which is the failure mode a skipped test hides.
    const declared = assetFiles().filter((f) => ONE_SHOT_IDS.has(f.replace(/\.json$/, '')));
    expect(declared.length).toBe(ONE_SHOT_IDS.size);
    for (const file of declared) {
      const doc = read(file);
      const seconds = doc.op / doc.fr;
      expect(seconds).toBeGreaterThanOrEqual(ONE_SHOT_LO);
      expect(seconds).toBeLessThanOrEqual(ONE_SHOT_HI);
    }
  });

  it('every file is under the 150 KB ceiling', () => {
    for (const file of assetFiles()) {
      expect(fs.statSync(path.join(ASSET_DIR, file)).size).toBeLessThanOrEqual(MAX_BYTES);
    }
  });

  it('is vector only: no image layers, no external assets', () => {
    for (const file of assetFiles()) {
      const doc = read(file);
      expect([file, doc.assets]).toEqual([file, []]);
      expect(doc.layers.some((l) => l.ty === 2)).toBe(false);
    }
  });

  it('uses the accent as the ONLY chromatic colour, everything else greyscale', () => {
    // A second hue is how a set like this drifts into looking like a different
    // app one file at a time.
    const offenders: string[] = [];
    const walk = (node: unknown, file: string) => {
      if (Array.isArray(node)) {
        for (const item of node) walk(item, file);
        return;
      }
      if (!node || typeof node !== 'object') return;
      const obj = node as Record<string, any>;
      if ((obj.ty === 'fl' || obj.ty === 'st') && obj.c?.k) {
        const [r, g, b] = obj.c.k as number[];
        const isAccent = [r, g, b].every((v, i) => Math.abs(v - ACCENT[i]) < 0.01);
        const isGrey = Math.abs(r - g) < 0.01 && Math.abs(g - b) < 0.01;
        if (!isAccent && !isGrey) offenders.push(`${file}: ${[r, g, b].join(',')}`);
      }
      for (const v of Object.values(obj)) walk(v, file);
    };
    for (const file of assetFiles()) walk(read(file).layers, file);
    expect(offenders).toEqual([]);
  });

  it('paints no full-canvas background, since the app shows its own through it', () => {
    const offenders: string[] = [];
    const walk = (node: unknown, file: string) => {
      if (Array.isArray(node)) {
        for (const item of node) walk(item, file);
        return;
      }
      if (!node || typeof node !== 'object') return;
      const obj = node as Record<string, any>;
      if ((obj.ty === 'rc' || obj.ty === 'el') && Array.isArray(obj.s?.k)) {
        const [w, h] = obj.s.k as number[];
        if (w >= 900 && h >= 900) offenders.push(`${file}: ${w}x${h}`);
      }
      for (const v of Object.values(obj)) walk(v, file);
    };
    for (const file of assetFiles()) walk(read(file).layers, file);
    expect(offenders).toEqual([]);
  });
});
