import { render, screen } from '@testing-library/react-native';
import React from 'react';
import ShareStatsCard, {
  EXPORT_HEIGHT,
  EXPORT_WIDTH,
  hostSizeForScale,
} from '../ShareStatsCard';
import { toFileUri } from '../capture-and-share';
import { emptyReadingStats, type ReadingStats } from '@/lib/stats/reading-stats';

// MeraLogo pulls in reanimated + react-native-svg, which have no native side
// under jest. Same stub the profile and card suites already use. That leaves
// ONE thing this suite cannot answer: whether an SVG glyph actually rasterises
// into a captureRef PNG. Nothing in P0 exercised react-native-svg either, so
// the brand mark is a device-verification item, not a covered one.
// AbstractGradientBackdrop drags in reanimated and react-native-svg, which have
// no native side under jest. It has its own suite; here it is a prop recorder,
// so the card's contract with it (seeded AND frame-pinned, or two shares of the
// same stats produce different PNGs) is still asserted below.
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
    countryCount: 6,
    articlesOpened: 58,
    publishToRead: { averageHours: 8.6, sampledArticles: 41, totalArticles: 58 },
    hasAnyData: true,
    ...overrides,
  };
}

describe('hostSizeForScale', () => {
  // This is the P0 finding, pinned. captureRef's width/height are POINTS that
  // get multiplied by the device pixel ratio: a 1080x1920 request on a 3x
  // device returned a 3240x5760 PNG. So the host must be laid out at
  // EXPORT / scale points for the capture to land on the export size, and
  // there is no post-capture resize to fall back on because
  // expo-image-manipulator is not installed.
  it('is the export size divided by the device scale', () => {
    expect(hostSizeForScale(3)).toEqual({ width: 360, height: 640 });
    expect(hostSizeForScale(2)).toEqual({ width: 540, height: 960 });
    expect(hostSizeForScale(1)).toEqual({ width: EXPORT_WIDTH, height: EXPORT_HEIGHT });
  });

  it('multiplies back up to exactly the export size at every scale', () => {
    for (const scale of [1, 2, 2.75, 3, 3.5]) {
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
  // captureRef returned bare absolute paths with no scheme on the simulator.
  it('adds the scheme to a bare path and leaves a real URI alone', () => {
    expect(toFileUri('/var/tmp/ReactNative/x.png')).toBe('file:///var/tmp/ReactNative/x.png');
    expect(toFileUri('file:///var/tmp/x.png')).toBe('file:///var/tmp/x.png');
  });
});

describe('ShareStatsCard', () => {
  it('renders the four figures', () => {
    render(<ShareStatsCard stats={stats()} showPublicationNames={false} pixelRatio={3} />);

    expect(screen.getByText('17')).toBeTruthy();
    expect(screen.getByText('6')).toBeTruthy();
    expect(screen.getByText('58')).toBeTruthy();
    expect(screen.getByText('shareStats.card.latencyValue:{"count":9}')).toBeTruthy();
  });

  it('always carries the coverage denominator beside the latency figure', () => {
    render(<ShareStatsCard stats={stats()} showPublicationNames={false} pixelRatio={3} />);

    expect(
      screen.getByText('shareStats.card.latencyCoverage:{"sampled":41,"total":58}'),
    ).toBeTruthy();
  });

  it('says there is not enough data instead of showing a zero average', () => {
    render(
      <ShareStatsCard
        stats={stats({ publishToRead: { averageHours: null, sampledArticles: 0, totalArticles: 58 } })}
        showPublicationNames={false}
        pixelRatio={3}
      />,
    );

    expect(screen.getByText('shareStats.card.latencyUnknown')).toBeTruthy();
    // No denominator without an average: "based on 0 of 58" alongside no figure
    // reads as a broken card rather than as missing data.
    expect(screen.queryByText(/latencyCoverage/)).toBeNull();
  });

  it('mounts the app backdrop SEEDED AND FRAME-PINNED', () => {
    // Both halves are load-bearing. The seed fixes the colour sequence; the
    // frame fixes the position in it, because the backdrop's step is a shared,
    // time-driven global. Seed alone and two shares of identical stats 45
    // seconds apart produce different PNGs.
    render(<ShareStatsCard stats={stats()} showPublicationNames={false} pixelRatio={3} />);

    const backdrop = screen.getByTestId('card-backdrop');
    expect(backdrop.props.seed).toBe('mera-stats-card');
    expect(backdrop.props.frame).toBe(0);
  });

  it('labels the opened count partial, every time', () => {
    render(<ShareStatsCard stats={stats()} showPublicationNames={false} pixelRatio={3} />);

    expect(screen.getByText('shareStats.card.openedPartial')).toBeTruthy();
  });

  describe('the naming opt-in', () => {
    const withPublications = stats({
      topPublications: [
        { publicationName: 'The Hindu', countryCode: 'IN', visitCount: 9 },
        { publicationName: 'Le Monde', countryCode: 'FR', visitCount: 4 },
      ],
    });

    it('omits the whole block when off, rather than rendering an empty one', () => {
      render(
        <ShareStatsCard stats={withPublications} showPublicationNames={false} pixelRatio={3} />,
      );

      expect(screen.queryByTestId('share-stats-card-top-publications')).toBeNull();
      expect(screen.queryByText('The Hindu')).toBeNull();
    });

    it('names publications only when on', () => {
      render(<ShareStatsCard stats={withPublications} showPublicationNames pixelRatio={3} />);

      expect(screen.getByTestId('share-stats-card-top-publications')).toBeTruthy();
      expect(screen.getByText('The Hindu')).toBeTruthy();
      expect(screen.getByText('Le Monde')).toBeTruthy();
    });

    it('stays absent when the toggle is on but there is nothing to name', () => {
      render(<ShareStatsCard stats={stats({ topPublications: [] })} showPublicationNames pixelRatio={3} />);

      expect(screen.queryByTestId('share-stats-card-top-publications')).toBeNull();
    });
  });

  it('gives every text node a lineHeight alongside its fontSize', () => {
    // The P0 spike's other finding, and the reason `type()` exists.
    // components/ui/text merges caller `style` AFTER its own size token, so an
    // inline fontSize wins while the token's much smaller lineHeight survives,
    // and React Native clips the glyph to that line box. A 96pt "42" under a
    // 24pt line height rasterised as a dash and an underline stroke, and the
    // same clipping ate the above-base matras off Devanagari at 22pt.
    const tree = render(
      <ShareStatsCard
        stats={stats({
          topPublications: [{ publicationName: 'NHK', countryCode: 'JP', visitCount: 2 }],
        })}
        showPublicationNames
        pixelRatio={3}
      />,
    );

    const flatten = (style: unknown): Record<string, unknown> =>
      Array.isArray(style)
        ? style.reduce<Record<string, unknown>>((acc, s) => ({ ...acc, ...flatten(s) }), {})
        : ((style ?? {}) as Record<string, unknown>);

    const texts = tree.UNSAFE_getAllByType(
      require('react-native').Text as React.ComponentType<Record<string, unknown>>,
    );
    let checked = 0;
    for (const node of texts) {
      const style = flatten(node.props.style);
      if (style.fontSize === undefined) continue;
      checked += 1;
      expect(typeof style.lineHeight).toBe('number');
      expect(style.lineHeight as number).toBeGreaterThan(style.fontSize as number);
    }
    // Without this the loop above passes by skipping every node, which is
    // exactly the shape of a check that cannot fail.
    expect(checked).toBeGreaterThanOrEqual(11);
  });

  it('turns OS Dynamic Type off on every line, because the card is a fixed raster', () => {
    const tree = render(<ShareStatsCard stats={stats()} showPublicationNames={false} pixelRatio={3} />);

    const texts = tree.UNSAFE_getAllByType(
      require('react-native').Text as React.ComponentType<Record<string, unknown>>,
    );

    for (const node of texts) {
      expect(node.props.allowFontScaling).toBe(false);
    }
  });
});
