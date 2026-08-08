/**
 * The lock on the type system.
 *
 * Three things have to stay true and none of them are visible in a diff:
 *  1. `<Text size="X">` and `<Heading size="X">` mean the SAME pixels. They were
 *     offset by one step (`Heading size="3xl"` rendered `text-4xl`), which made
 *     TranslatableStatic/TranslatableDynamic — one `size` prop forwarded to
 *     either component depending on `as` — render two different sizes for one
 *     value at seven call sites.
 *  2. `lib/typography/scale.ts` mirrors `tailwind.config.js`, because a runtime
 *     text-size control cannot read build-time Tailwind tokens and so has to
 *     duplicate them.
 *  3. Nothing in the scale falls below the platform's minimum readable size, and
 *     every step carries explicit leading (React Native treats `lineHeight` as a
 *     hard line box, so a missing one clips Devanagari/Thai/Vietnamese marks).
 */
import { textStyle } from '../text/styles';
import { headingStyle } from '../heading/styles';
import {
  MIN_FONT_SIZE_PX,
  TYPE_SCALE,
  TYPE_TOKENS,
  tokenFromClassName,
  type TypeToken,
} from '@/lib/typography/scale';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const tailwindConfig = require('../../../tailwind.config.js');
const tailwindFontSize: Record<string, [string, { lineHeight: string }]> =
  tailwindConfig.theme.extend.fontSize;

/** The size-variant names each component accepts, read off the real tva maps. */
const SIZE_NAMES = [
  '2xs',
  'xs',
  'sm',
  'md',
  'lg',
  'xl',
  '2xl',
  '3xl',
  '4xl',
  '5xl',
  '6xl',
] as const;

/** The `text-*` class a merged tva output will actually render. */
function sizeClassOf(merged: string): string | null {
  const token = tokenFromClassName(merged);
  return token ? `text-${token}` : null;
}

describe('Text/Heading scale parity', () => {
  it.each(SIZE_NAMES)('size="%s" resolves to the same class on Text and Heading', (name) => {
    const text = sizeClassOf(textStyle({ size: name }));
    const heading = sizeClassOf(headingStyle({ size: name }));
    expect(text).not.toBeNull();
    expect(heading).toBe(text);
  });

  it('both components accept exactly the same size vocabulary', () => {
    for (const name of SIZE_NAMES) {
      expect(sizeClassOf(textStyle({ size: name }))).not.toBeNull();
      expect(sizeClassOf(headingStyle({ size: name }))).not.toBeNull();
    }
  });

  // The regression that started this: `Heading size="3xl"` used to render
  // text-4xl. If anyone reintroduces an offset, parity above fails — this
  // pins the specific pair that was wrong.
  it('Heading size="3xl" renders text-3xl, not text-4xl', () => {
    expect(sizeClassOf(headingStyle({ size: '3xl' }))).toBe('text-3xl');
  });
});

describe('lib/typography/scale.ts mirrors tailwind.config.js', () => {
  it('covers exactly the tokens Tailwind defines', () => {
    expect([...TYPE_TOKENS].sort()).toEqual(Object.keys(tailwindFontSize).sort());
  });

  it.each(TYPE_TOKENS)('%s has the same fontSize and lineHeight as Tailwind', (token) => {
    const [size, meta] = tailwindFontSize[token];
    expect(TYPE_SCALE[token].fontSize).toBe(parseFloat(size));
    expect(TYPE_SCALE[token].lineHeight).toBe(parseFloat(meta.lineHeight));
  });
});

describe('accessibility floor and leading', () => {
  it.each(TYPE_TOKENS)('%s is at or above the platform minimum', (token) => {
    expect(TYPE_SCALE[token].fontSize).toBeGreaterThanOrEqual(MIN_FONT_SIZE_PX);
  });

  it.each(TYPE_TOKENS)('%s declares an explicit lineHeight with script headroom', (token) => {
    const { fontSize, lineHeight } = TYPE_SCALE[token];
    expect(lineHeight).toBeGreaterThan(0);
    // 1.4 is the floor below which Devanagari matras and Thai upper vowels
    // start being sliced by React Native's hard line box.
    expect(lineHeight / fontSize).toBeGreaterThanOrEqual(1.4);
  });

  it('is monotonically increasing', () => {
    const sizes = TYPE_TOKENS.map((t) => TYPE_SCALE[t].fontSize);
    for (let i = 1; i < sizes.length; i++) {
      expect(sizes[i]).toBeGreaterThan(sizes[i - 1]);
    }
  });
});

describe('tokenFromClassName', () => {
  it('ignores colour classes', () => {
    expect(tokenFromClassName('text-white text-typography-700')).toBeNull();
  });

  it('takes the last size class, matching tailwind-merge precedence', () => {
    expect(tokenFromClassName('text-sm text-2xl')).toBe('2xl' as TypeToken);
  });

  it('finds a size class surrounded by other classes', () => {
    expect(tokenFromClassName('font-body text-lg text-white')).toBe('lg' as TypeToken);
  });

  it('returns null for undefined or empty input', () => {
    expect(tokenFromClassName(undefined)).toBeNull();
    expect(tokenFromClassName('')).toBeNull();
  });
});

/**
 * Repo-wide guard: no absolute `leading-<n>` on a text element.
 *
 * This is the one class of regression the token-level assertions above CANNOT
 * see, and this wave caused it once. Tailwind's numeric leading utilities are
 * absolute rem, and NativeWind inlines rem at 14 (`inlineRem` default), so
 * `leading-5` is a fixed 17.5px no matter what the font size is. Raising the
 * scale from a 14px root to a 16px one therefore TIGHTENED every one of them:
 * `text-base leading-5` went from 14/17.5 (1.25) to 16/17.5 (1.09) — a hard
 * line box below the Latin cap height, on 24 sites, in an app whose text is
 * machine-translated into 20 languages.
 *
 * At every one of those sites the size token's own lineHeight was LOOSER than
 * the class, so the fix was to delete the class. Multiplier leadings
 * (`leading-tight`, `leading-relaxed`) keep their ratio when the font size
 * changes and are deliberately allowed.
 */
describe('no absolute leading overrides on text elements', () => {
  const TAGS = ['Text', 'Heading', 'TranslatableDynamic', 'TranslatableStatic', 'FeedStatsSentence'];
  const TAG_RE = new RegExp(`<(${TAGS.join('|')})\\b((?:[^<>]|\\{[^{}]*\\})*?)(/?>)`, 'g');

  function scan(dir: string, out: string[]): string[] {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const fs = require('fs');
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const path = require('path');
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules') continue;
        scan(full, out);
      } else if (entry.name.endsWith('.tsx')) {
        const src: string = fs.readFileSync(full, 'utf8');
        TAG_RE.lastIndex = 0;
        let m: RegExpExecArray | null;
        while ((m = TAG_RE.exec(src)) !== null) {
          // A nested tag means the attribute span over-captured — skip it.
          if (m[2].includes('<')) continue;
          if (/\bleading-\d+\b/.test(m[2])) {
            out.push(`${full}:${src.slice(0, m.index).split('\n').length}`);
          }
        }
      }
    }
    return out;
  }

  it('finds none in app/ or components/', () => {
    const offenders = [...scan('app', []), ...scan('components', [])];
    expect(offenders).toEqual([]);
  });
});
