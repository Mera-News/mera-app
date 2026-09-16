import { render } from '@testing-library/react-native';
import React from 'react';
import ShareStatsCard, {
  EXPORT_HEIGHT,
  EXPORT_WIDTH,
  hostSizeForScale,
} from '../ShareStatsCard';
import { toFileUri } from '../capture-and-share';
import { emptyReadingStats, type ReadingStats } from '@/lib/stats/reading-stats';

// MeraLogo and AbstractGradientBackdrop pull in reanimated and
// react-native-svg, which have no native side under jest. The backdrop is a
// prop recorder rather than a null, so the card's contract with it (seeded AND
// frame-pinned, or two shares of the same stats produce different PNGs) is
// still asserted below. That leaves ONE thing this suite cannot answer:
// whether an SVG glyph, or a regional-indicator flag pair, actually rasterises
// into a captureRef PNG. Both are device-verification items.
jest.mock('@/components/custom/AbstractGradientBackdrop', () => {
  const { View } = require('react-native');
  return {
    __esModule: true,
    default: (p: Record<string, unknown>) => <View testID="card-backdrop" {...p} />,
  };
});

jest.mock('@/components/custom/MeraLogo', () => {
  const { View } = require('react-native');
  return { __esModule: true, default: (p: Record<string, unknown>) => <View testID="mera-logo" {...p} /> };
});

jest.mock('react-i18next', () => ({
  useTranslation: () => ({
    // Echo the key plus its interpolations, so a test can assert WHICH string
    // rendered and with what numbers without pinning English wording.
    t: (key: string, vars?: Record<string, unknown>) =>
      vars ? `${key}:${JSON.stringify(vars)}` : key,
  }),
}));

function stats(overrides: Partial<ReadingStats> = {}): ReadingStats {
  return {
    ...emptyReadingStats(),
    publicationCount: 17,
    countryCount: 3,
    countries: [
      { countryCode: 'IN', visitCount: 38 },
      { countryCode: 'US', visitCount: 22 },
      { countryCode: 'GB', visitCount: 14 },
    ],
    articlesOpened: 58,
    publishToRead: { averageHours: 8.6, sampledArticles: 41, totalArticles: 58 },
    keptNow: { savedArticles: 28, followedStories: 6 },
    hasAnyData: true,
    ...overrides,
  };
}

describe('hostSizeForScale', () => {
  // captureRef's width/height are POINTS that get multiplied by the device
  // pixel ratio: a 1080x1920 request on a 3x device returned a 3240x5760 PNG.
  // So the host must be laid out at EXPORT / scale points for the capture to
  // land on the export size, and there is no post-capture resize to fall back
  // on because expo-image-manipulator is not installed.
  it('is the export size divided by the device scale', () => {
    expect(hostSizeForScale(3)).toEqual({ width: 360, height: 640 });
    expect(hostSizeForScale(2)).toEqual({ width: 540, height: 960 });
  });

  it('multiplies back up to exactly the export size at every scale', () => {
    for (const scale of [1, 1.5, 2, 2.75, 3]) {
      const host = hostSizeForScale(scale);
      expect(host.width * scale).toBeCloseTo(EXPORT_WIDTH, 6);
      expect(host.height * scale).toBeCloseTo(EXPORT_HEIGHT, 6);
    }
  });

  it('falls back to 1 rather than dividing by a nonsense scale', () => {
    expect(hostSizeForScale(0)).toEqual({ width: EXPORT_WIDTH, height: EXPORT_HEIGHT });
    expect(hostSizeForScale(Number.NaN)).toEqual({ width: EXPORT_WIDTH, height: EXPORT_HEIGHT });
  });

  it('keeps the 9:16 ratio Instagram Stories needs', () => {
    expect(EXPORT_WIDTH / EXPORT_HEIGHT).toBeCloseTo(9 / 16, 6);
  });
});

describe('toFileUri', () => {
  it('adds the scheme to a bare path and leaves a real URI alone', () => {
    expect(toFileUri('/var/mobile/x.png')).toBe('file:///var/mobile/x.png');
    expect(toFileUri('file:///var/mobile/x.png')).toBe('file:///var/mobile/x.png');
  });
});

describe('the dispatcher', () => {
  it('draws each card by id', () => {
    for (const [card, testID] of [
      ['reach', 'share-stats-card-reach'],
      ['keep', 'share-stats-card-keep'],
      ['pace', 'share-stats-card-pace'],
    ] as const) {
      const { getByTestId } = render(
        <ShareStatsCard card={card} stats={stats()} pixelRatio={3} />,
      );
      expect(getByTestId(testID)).toBeTruthy();
    }
  });

  it('draws the reach card when no id is given, as the shipped deep link does', () => {
    const { getByTestId } = render(<ShareStatsCard stats={stats()} pixelRatio={3} />);
    expect(getByTestId('share-stats-card-reach')).toBeTruthy();
  });

  it('mounts the app backdrop SEEDED AND FRAME-PINNED on every card', () => {
    // The seed alone is NOT enough. It fixes the colour SEQUENCE, while a
    // module-level step advanced by a shared 45s interval picks the position in
    // it, so a seeded-only backdrop drifts and two shares of the same stats
    // produce different files.
    for (const card of ['reach', 'keep', 'pace'] as const) {
      const { getByTestId } = render(
        <ShareStatsCard card={card} stats={stats()} pixelRatio={3} />,
      );
      const backdrop = getByTestId('card-backdrop');
      expect(backdrop.props.seed).toBe('mera-stats-card');
      expect(backdrop.props.frame).toBe(0);
    }
  });
});

describe('each card states exactly ONE window', () => {
  // Countries, publications, opened and publish-to-read are 30-day. Saved and
  // followed are present tense. A card that mixed them would carry a heading
  // true of neither, which is the overclaim this split exists to refuse.
  it('puts the 30-day line on reach and pace', () => {
    for (const card of ['reach', 'pace'] as const) {
      const { getByTestId } = render(
        <ShareStatsCard card={card} stats={stats()} pixelRatio={3} />,
      );
      expect(getByTestId(`share-stats-card-${card}-window`).props.children).toBe(
        'shareStats.screenSubtitle',
      );
    }
  });

  it('puts the present-tense line on keep, and never a 30-day claim', () => {
    const { getByTestId } = render(<ShareStatsCard card="keep" stats={stats()} pixelRatio={3} />);
    expect(getByTestId('share-stats-card-keep-window').props.children).toBe(
      'shareStats.card.windowNow',
    );
  });
});

describe('top publications', () => {
  const withNames = stats({
    topPublications: [
      { publicationName: 'Le Monde', countryCode: 'FR', visitCount: 9 },
      { publicationName: 'NHK', countryCode: 'JP', visitCount: 4 },
    ],
  });

  it('is ON by default, without the reader turning anything on', () => {
    const { getByText, getByTestId } = render(
      <ShareStatsCard card="reach" stats={withNames} pixelRatio={3} />,
    );
    expect(getByTestId('share-stats-reach-top-publications')).toBeTruthy();
    expect(getByText('Le Monde')).toBeTruthy();
  });

  it('can still be declined, and is then ABSENT rather than empty', () => {
    // The control is deliberately kept. This card is made to be posted in
    // public and publication names are revealing, so removing the only way to
    // decline is a different decision from changing the default.
    const { queryByText, queryByTestId } = render(
      <ShareStatsCard card="reach" stats={withNames} showPublicationNames={false} pixelRatio={3} />,
    );
    expect(queryByTestId('share-stats-reach-top-publications')).toBeNull();
    expect(queryByText('Le Monde')).toBeNull();
  });

  it('stays absent when the block is on but there is nothing to name', () => {
    const { queryByTestId } = render(
      <ShareStatsCard card="reach" stats={stats()} showPublicationNames pixelRatio={3} />,
    );
    expect(queryByTestId('share-stats-reach-top-publications')).toBeNull();
  });

  it('never appears on the other two cards, whatever the flag says', () => {
    for (const card of ['keep', 'pace'] as const) {
      const { queryByText } = render(
        <ShareStatsCard card={card} stats={withNames} showPublicationNames pixelRatio={3} />,
      );
      expect(queryByText('Le Monde')).toBeNull();
    }
  });

  it('cannot show an article title, because no card is given one', () => {
    // The half of the old promise that is still true and must stay true, and
    // it is STRUCTURAL rather than rendered. A render assertion would be the
    // weaker check and, with a key-echoing t() mock, a misleading one: it
    // matched "reachTitle" and passed for the wrong reason on the first
    // attempt. The real guarantee is that ReadingStats carries no article text
    // at all, so there is nothing for a card to leak however it is written.
    const perPublication = withNames.topPublications[0];
    expect(Object.keys(perPublication).sort()).toEqual([
      'countryCode',
      'publicationName',
      'visitCount',
    ]);
    // And nothing anywhere in the payload is an article title.
    const flat = JSON.stringify(withNames);
    expect(flat).not.toContain('title');
    expect(flat).not.toContain('articleId');
  });
});

describe('ReachCard', () => {
  it('renders both counts and a flag per country', () => {
    const { getByTestId } = render(<ShareStatsCard card="reach" stats={stats()} pixelRatio={3} />);
    expect(getByTestId('share-stats-reach-countries')).toBeTruthy();
    expect(getByTestId('share-stats-reach-publications')).toBeTruthy();
    expect(getByTestId('share-stats-reach-flags-cell-IN')).toBeTruthy();
    expect(getByTestId('share-stats-reach-flags-cell-GB')).toBeTruthy();
  });

  it('weights the proportion bar by taps, with the leader in the accent', () => {
    const { getByTestId } = render(<ShareStatsCard card="reach" stats={stats()} pixelRatio={3} />);
    const lead = getByTestId('share-stats-reach-bar-segment-IN').props.style;
    expect(lead.flex).toBeCloseTo(38 / 74, 6);
    expect(lead.backgroundColor).toBe('rgb(231, 138, 83)');
  });

  it('omits the bar entirely when there is nothing to divide', () => {
    const { queryByTestId } = render(
      <ShareStatsCard card="reach" stats={emptyReadingStats()} pixelRatio={3} />,
    );
    expect(queryByTestId('share-stats-reach-bar')).toBeNull();
  });
});

describe('KeepCard', () => {
  it('renders a dot per saved article and a ring per followed story', () => {
    const { getByTestId } = render(<ShareStatsCard card="keep" stats={stats()} pixelRatio={3} />);
    expect(getByTestId('share-stats-keep-saved-dots').children).toHaveLength(28);
    expect(getByTestId('share-stats-keep-followed-dots').children).toHaveLength(6);
  });

  it('says the two are kept until removed, rather than implying a window', () => {
    const { getByTestId } = render(<ShareStatsCard card="keep" stats={stats()} pixelRatio={3} />);
    expect(getByTestId('share-stats-keep-note')).toBeTruthy();
  });
});

describe('PaceCard', () => {
  it('labels the opened count partial, every time', () => {
    const { getByTestId } = render(<ShareStatsCard card="pace" stats={stats()} pixelRatio={3} />);
    expect(getByTestId('share-stats-pace-opened-partial')).toBeTruthy();
  });

  it('always carries the coverage denominator beside the latency figure', () => {
    // A bare average over the covered subset, presented as the whole, is the
    // specific claim this line exists to refuse.
    const { getByTestId } = render(<ShareStatsCard card="pace" stats={stats()} pixelRatio={3} />);
    expect(getByTestId('share-stats-pace-coverage').props.children).toContain('"sampled":41');
    expect(getByTestId('share-stats-pace-coverage').props.children).toContain('"total":58');
  });

  it('places the marker on the value against a 48h scale', () => {
    const { getByTestId } = render(<ShareStatsCard card="pace" stats={stats()} pixelRatio={3} />);
    // 8.6 rounds to 9; 9/48 = 18.75%.
    expect(getByTestId('share-stats-pace-scale-marker').props.style.left).toBe('18.75%');
  });

  it('says there is not enough data instead of showing a zero average', () => {
    // Null is NOT zero: zero would read as "instant".
    const { getByTestId, queryByTestId } = render(
      <ShareStatsCard
        card="pace"
        stats={stats({ publishToRead: { averageHours: null, sampledArticles: 0, totalArticles: 12 } })}
        pixelRatio={3}
      />,
    );
    expect(getByTestId('share-stats-pace-unknown')).toBeTruthy();
    // And draws no scale: a marker with nothing to mark is worse than none.
    expect(queryByTestId('share-stats-pace-scale')).toBeNull();
    expect(queryByTestId('share-stats-pace-coverage')).toBeNull();
  });
});

describe('every text node on every card', () => {
  const flatten = (style: unknown): Record<string, unknown> =>
    Array.isArray(style)
      ? style.reduce<Record<string, unknown>>((acc, s) => ({ ...acc, ...flatten(s) }), {})
      : ((style ?? {}) as Record<string, unknown>);

  function textNodes(card: 'reach' | 'keep' | 'pace') {
    const tree = render(<ShareStatsCard card={card} stats={stats()} pixelRatio={3} />);
    return tree.UNSAFE_getAllByType(
      require('react-native').Text as React.ComponentType<Record<string, unknown>>,
    );
  }

  it('gives every node a lineHeight alongside its fontSize', () => {
    // components/ui/text merges caller style AFTER its own size token, so an
    // inline fontSize wins while the token's much smaller lineHeight survives
    // and React Native clips the glyph to that line box. A 96pt numeral
    // rasterised as a dash and an underline stroke, and the same clipping ate
    // the above-base matras off Devanagari at an ordinary 22pt.
    let checked = 0;
    for (const card of ['reach', 'keep', 'pace'] as const) {
      for (const node of textNodes(card)) {
        const style = flatten(node.props.style);
        if (style.fontSize === undefined) continue;
        checked += 1;
        expect(typeof style.lineHeight).toBe('number');
        expect(style.lineHeight as number).toBeGreaterThan(style.fontSize as number);
      }
    }
    // Without this the loop passes by skipping every node, which is exactly the
    // shape of a check that cannot fail.
    expect(checked).toBeGreaterThanOrEqual(24);
  });

  it('gives every node an explicit colour, never an inherited one', () => {
    // The invisible-card bug in its general form: a text node with no colour of
    // its own inherits, and what it inherits on a fixed raster is not
    // guaranteed to be legible on the gradient behind it.
    let checked = 0;
    for (const card of ['reach', 'keep', 'pace'] as const) {
      for (const node of textNodes(card)) {
        const style = flatten(node.props.style);
        if (style.fontSize === undefined) continue;
        checked += 1;
        expect(typeof style.color).toBe('string');
        expect(style.color).toMatch(/^(rgba?\()/);
      }
    }
    expect(checked).toBeGreaterThanOrEqual(24);
  });

  it('turns OS Dynamic Type off on every line, because the card is a fixed raster', () => {
    for (const card of ['reach', 'keep', 'pace'] as const) {
      for (const node of textNodes(card)) {
        expect(node.props.allowFontScaling).toBe(false);
      }
    }
  });
});
