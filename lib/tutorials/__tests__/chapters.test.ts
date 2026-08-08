// Registry integrity. This is the test that keeps the tutorials module honest
// as copy lands and as animations (eventually) arrive.
//
// It asserts three separate things, and each one exists because prose alone was
// not enough to keep it true:
//
//  1. Every i18n key DERIVED from the registry resolves in `en.json`. i18next
//     returns the key string back when a key is missing, so asserting through
//     `t()` would pass on exactly the failure this is for — hence `lookupKey`
//     against the parsed JSON.
//  2. NO ANIMATION RUNTIME. This wave ships without `lottie-react-native` in
//     `package.json`, and Metro resolves `require()` at BUNDLE time — so a
//     single uncommented mention of it under `components/custom/tutorials/`
//     would be a build error that no runtime guard could catch, on a wave whose
//     headline benefit is being OTA-able. The check is mechanical because the
//     rule is one grep away from being broken by a well-meaning edit.
//  3. Chapter `welcome` carries no mera logo — the user's explicit instruction
//     for the pre-auth chapter.

import fs from 'fs';
import path from 'path';

import en from '@/lib/locales/en.json';
import { TUTORIAL_CHAPTERS, chaptersAtLevel, getChapter } from '../chapters';
import { animationIdFor, keysForChapter, lookupKey } from '../keys';

const REPO_ROOT = path.resolve(__dirname, '../../..');

/** Source trees the no-animation rule applies to. */
const GUARDED_DIRS = [
  path.join(REPO_ROOT, 'components/custom/tutorials'),
  path.join(REPO_ROOT, 'lib/tutorials'),
];

function sourceFilesUnder(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .flatMap((entry) => {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) return sourceFilesUnder(full);
      return /\.(ts|tsx)$/.test(entry.name) ? [full] : [];
    });
}

/**
 * Strip `//` and block comments so a DELIBERATELY commented-out registry entry
 * (the whole point of `animation-registry.ts`) does not trip the guard, while a
 * real import still does.
 */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map((line) => line.replace(/\/\/.*$/, ''))
    .join('\n');
}

describe('TUTORIAL_CHAPTERS', () => {
  it('has twelve chapters split across the two levels', () => {
    expect(TUTORIAL_CHAPTERS).toHaveLength(12);
    expect(chaptersAtLevel('basic')).toHaveLength(7);
    expect(chaptersAtLevel('advanced')).toHaveLength(5);
  });

  it('has unique chapter ids, and unique slide ids within each chapter', () => {
    const chapterIds = TUTORIAL_CHAPTERS.map((c) => c.id);
    expect(new Set(chapterIds).size).toBe(chapterIds.length);

    for (const chapter of TUTORIAL_CHAPTERS) {
      const slideIds = chapter.slides.map((s) => s.id);
      expect(new Set(slideIds).size).toBe(slideIds.length);
      expect(chapter.slides.length).toBeGreaterThan(0);
    }
  });

  it('derives a unique animation id for every slide', () => {
    const ids = TUTORIAL_CHAPTERS.flatMap((chapter) =>
      chapter.slides.map((slide) => animationIdFor(chapter.id, slide.id)),
    );
    expect(new Set(ids).size).toBe(ids.length);
    // Around sixty slides; the exact number moves as copy lands, the uniqueness
    // does not.
    expect(ids.length).toBeGreaterThanOrEqual(55);
  });

  it('gives every slide a placeholder — it is the shipped visual layer', () => {
    for (const chapter of TUTORIAL_CHAPTERS) {
      for (const slide of chapter.slides) {
        expect(slide.visual.placeholder).toBeDefined();
        expect(typeof slide.visual.placeholder.kind).toBe('string');
      }
    }
  });

  it('uses all five placeholder kinds', () => {
    const kinds = new Set(
      TUTORIAL_CHAPTERS.flatMap((c) => c.slides.map((s) => s.visual.placeholder.kind)),
    );
    expect([...kinds].sort()).toEqual(['cards', 'icon', 'logo', 'orbit', 'steps']);
  });

  it('references no animation asset anywhere in the registry', () => {
    for (const chapter of TUTORIAL_CHAPTERS) {
      for (const slide of chapter.slides) {
        expect(slide.visual.animation).toBeUndefined();
      }
    }
  });

  it('keeps the mera logo out of the pre-auth chapter', () => {
    const welcome = getChapter('welcome');
    expect(welcome).toBeDefined();
    for (const slide of welcome!.slides) {
      expect(slide.visual.placeholder.kind).not.toBe('logo');
    }
  });

  it('never offers Ask Mera on the pre-auth chapter', () => {
    // Belt and braces: the player also hard-disables it via `enableAskMera`,
    // but a slide that WANTS the button pre-auth is an authoring mistake.
    for (const slide of getChapter('welcome')!.slides) {
      expect(slide.hasAsk).toBeFalsy();
    }
  });
});

describe('tutorial copy', () => {
  it('resolves every derived i18n key in en.json', () => {
    const missing: string[] = [];
    let checked = 0;

    for (const chapter of TUTORIAL_CHAPTERS) {
      for (const key of keysForChapter(chapter)) {
        checked += 1;
        const value = lookupKey(en, key);
        if (typeof value !== 'string' || value.trim().length === 0) {
          missing.push(key);
        }
      }
    }

    expect(missing).toEqual([]);
    expect(checked).toBeGreaterThanOrEqual(200);
  });

  it('resolves the module chrome keys the player and menu render', () => {
    const chrome = [
      'entryRow',
      'menuTitle',
      'menuSubtitle',
      'sectionBasic',
      'sectionAdvanced',
      'progress',
      'advancedLockedTitle',
      'completedBadge',
      'empty',
      'close',
      'skip',
      'back',
      'next',
      'done',
      'continueAnyway',
      'slideProgress',
      'askMera',
      // Rendered by ChatSessionView, not by this module — the `generic` chat
      // context is reachable only from a tutorial slide, so its intro line lives
      // in this namespace and is checked here.
      'chatIntro',
      'launchButton',
      'hintReveal',
      'hintRevealSome',
      'hintChoose',
      'hintSort',
      'hintSortPick',
      'hintBeforeAfter',
      'beforeLabel',
      'afterLabel',
      'sortDone',
    ];

    const missing = chrome.filter(
      (suffix) => typeof lookupKey(en, `tutorials.${suffix}`) !== 'string',
    );
    expect(missing).toEqual([]);
  });

  it('carries both plural forms for the counted strings', () => {
    for (const base of ['tutorials.slideCount', 'tutorials.advancedLockedBody']) {
      expect(typeof lookupKey(en, `${base}_one`)).toBe('string');
      expect(typeof lookupKey(en, `${base}_other`)).toBe('string');
    }
  });
});

describe('no animation runtime', () => {
  it('never mentions lottie in tutorials source', () => {
    const offenders: string[] = [];

    for (const dir of GUARDED_DIRS) {
      for (const file of sourceFilesUnder(dir)) {
        // This spec file necessarily contains the word; skip itself.
        if (file === __filename) continue;
        const code = stripComments(fs.readFileSync(file, 'utf8'));
        if (/lottie/i.test(code)) offenders.push(path.relative(REPO_ROOT, file));
      }
    }

    expect(offenders).toEqual([]);
  });

  it('guards a directory that actually has files in it', () => {
    // Without this, the check above passes vacuously if the tree ever moves.
    const total = GUARDED_DIRS.reduce(
      (sum, dir) => sum + sourceFilesUnder(dir).length,
      0,
    );
    expect(total).toBeGreaterThan(5);
  });

  it('does not depend on an animation package', () => {
    const pkg = JSON.parse(
      fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8'),
    ) as { dependencies?: Record<string, string> };
    expect(pkg.dependencies?.['lottie-react-native']).toBeUndefined();
  });
});
