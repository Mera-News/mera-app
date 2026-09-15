// The asset contract, as a repo gate rather than a ritual.
//
// `scripts/animations/validate.py` is the full check and it decides things this
// cannot cheaply (the frame-by-frame bounding-box sweep, seam closure per
// animated property). What lives here is the subset that must never regress
// without a test going red: the files the two registries `require()` exist, and
// every file in the directory still meets the mechanical lines of the contract.
//
// Metro resolves `require()` at BUNDLE time, so a registry entry pointing at a
// missing file is a build error no runtime guard can catch. This turns that
// into a test failure with a filename in it instead.
import fs from 'fs';
import path from 'path';

import { PROCESSING_ANIMATIONS } from '../animation-registry';
import { TUTORIAL_ANIMATIONS } from '@/components/custom/tutorials/animation-registry';
import { PROCESSING_STAGE_IDS } from '../types';

const REPO_ROOT = path.resolve(__dirname, '../../../..');
const ASSET_DIR = path.join(REPO_ROOT, 'assets/animations');

const ACCENT = [231 / 255, 138 / 255, 83 / 255];
const MAX_BYTES = 150 * 1024;

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
  it('has a processing animation for every stage id', () => {
    expect(Object.keys(PROCESSING_ANIMATIONS).sort()).toEqual([...PROCESSING_STAGE_IDS].sort());
  });

  it.each([...PROCESSING_STAGE_IDS])('has processing-%s.json on disk', (stage) => {
    expect(fs.existsSync(path.join(ASSET_DIR, `processing-${stage}.json`))).toBe(true);
  });

  it('has one tutorial hero per chapter, all twelve on disk', () => {
    const ids = Object.keys(TUTORIAL_ANIMATIONS);
    expect(ids).toHaveLength(12);
    for (const id of ids) {
      expect(fs.existsSync(path.join(ASSET_DIR, `${id}.json`))).toBe(true);
    }
  });

  it('leaves no orphan in the directory that no registry claims', () => {
    const claimed = new Set([
      ...PROCESSING_STAGE_IDS.map((s) => `processing-${s}.json`),
      ...Object.keys(TUTORIAL_ANIMATIONS).map((id) => `${id}.json`),
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
      const doc = read(file);
      const seconds = doc.op / doc.fr;
      expect(seconds).toBeGreaterThanOrEqual(2);
      expect(seconds).toBeLessThanOrEqual(4);
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
