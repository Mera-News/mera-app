// Every rule is pinned against a REAL URL taken from the live probe that
// validated it, plus a near-miss that must pass through untouched.

import {
  upgradeImageUrl,
  matchingRuleId,
  HERO_TARGET_PX,
  COMPACT_TARGET_PX,
} from '../upgrade-image-url';

describe('R1 — WordPress size suffix (live: 11/12 hosts improved, 0 broken)', () => {
  const real = 'https://www.alphatv.gr/wp-content/uploads/2026/09/photo-300x200.jpg';

  it('strips the size suffix (measured 300x200 -> 1200x800)', () => {
    expect(upgradeImageUrl(real, HERO_TARGET_PX)).toBe(
      'https://www.alphatv.gr/wp-content/uploads/2026/09/photo.jpg',
    );
  });

  it('skips a filename that already carries a crop spec (measured 404)', () => {
    // images.cdn.nos.nl renders from a crop box; the bare name does not exist.
    const cdn = 'https://images.cdn.nos.nl/5/C/3/m/0x100x1600x900-1024x576.webp';
    expect(upgradeImageUrl(cdn, HERO_TARGET_PX)).toBe(cdn);
  });

  it('is skipped on a compact target, because it has no size control', () => {
    expect(upgradeImageUrl(real, COMPACT_TARGET_PX)).toBe(real);
  });

  it('passes a near-miss through by reference', () => {
    const near = 'https://example.com/photo.jpg';
    expect(upgradeImageUrl(near, HERO_TARGET_PX)).toBe(near);
  });
});

describe('R2 — query width raise (live: 4/5 improved, 0 broken)', () => {
  it('raises the width (measured static.bonniernews.se 600x400 -> 1200x800)', () => {
    const real = 'https://static.bonniernews.se/img/abc.jpg?width=600';
    expect(upgradeImageUrl(real, HERO_TARGET_PX)).toBe(
      'https://static.bonniernews.se/img/abc.jpg?width=1200',
    );
  });

  it('scales a PINNED HEIGHT with the width, so the crop does not change', () => {
    // Measured failure this prevents: 722x406 -> 1200x406, an aspect change.
    const real = 'https://cdn.example.com/i.jpg?smart=true&width=600&height=400';
    expect(upgradeImageUrl(real, HERO_TARGET_PX)).toBe(
      'https://cdn.example.com/i.jpg?smart=true&width=1200&height=800',
    );
  });

  it('never LOWERS an already-large width', () => {
    const big = 'https://m1.quebecormedia.com/i.jpg?width=1440';
    expect(upgradeImageUrl(big, HERO_TARGET_PX)).toBe(big);
    expect(matchingRuleId(big, HERO_TARGET_PX)).toBe('skipped-already-large');
  });
});

describe('R3 — Photon resize (live: 4/4 improved, 0 broken)', () => {
  it('rewrites resize= to w= (measured maurice-info.mu 150x75 -> 750x375)', () => {
    const real = 'https://i0.wp.com/maurice-info.mu/wp-content/uploads/a.jpg?resize=150,75&ssl=1';
    expect(upgradeImageUrl(real, HERO_TARGET_PX)).toBe(
      'https://i0.wp.com/maurice-info.mu/wp-content/uploads/a.jpg?w=1200&ssl=1',
    );
  });

  it('handles the percent-encoded comma RSS actually ships', () => {
    const real = 'https://i0.wp.com/omegamedias.info/a.png?resize=696%2C310&ssl=1';
    expect(upgradeImageUrl(real, HERO_TARGET_PX)).toContain('?w=1200');
  });

  it('matches on the host even though it is preceded by // and not a dot', () => {
    const real = 'https://i0.wp.com/site.tld/a.png?resize=696%2C310';
    expect(matchingRuleId(real, HERO_TARGET_PX)).toBe('R3-photon-resize');
  });
});

describe('R4 — Blogger size segment (live: 8/8 improved, 0 broken)', () => {
  it('rewrites the bare /s72-c/ form (measured 72x72 -> 1080x720)', () => {
    const real = 'https://blogger.googleusercontent.com/img/b/R29vZ2xl/AVvXs/s72-c/photo.jpg';
    expect(upgradeImageUrl(real, HERO_TARGET_PX)).toBe(
      'https://blogger.googleusercontent.com/img/b/R29vZ2xl/AVvXs/s1600/photo.jpg',
    );
  });

  it('rewrites the /s72-w772-h557-c/ form, which this corpus really does ship', () => {
    const real =
      'https://blogger.googleusercontent.com/img/b/R29vZ2xl/AVvXs/s72-w772-h557-c/photo.jpg';
    expect(upgradeImageUrl(real, HERO_TARGET_PX)).toContain('/s1600/');
  });
});

describe('guards', () => {
  it('skips a query-signed URL (measured i.guim.co.uk -> 401)', () => {
    const signed = 'https://i.guim.co.uk/img/media/x.jpg?width=140&s=abc123';
    expect(upgradeImageUrl(signed, HERO_TARGET_PX)).toBe(signed);
    expect(matchingRuleId(signed, HERO_TARGET_PX)).toBe('skipped-signed');
  });

  it('skips sign= (measured media.ouest-france.fr -> 403)', () => {
    const signed = 'https://media.ouest-france.fr/v1/pictures/abc?width=320&sign=4477a5';
    expect(upgradeImageUrl(signed, HERO_TARGET_PX)).toBe(signed);
  });

  it('skips auth= on the Arc resizer hosts', () => {
    const signed = 'https://www.nacion.com/resizer/v2/ABC.png?auth=a6eb38&width=722';
    expect(upgradeImageUrl(signed, HERO_TARGET_PX)).toBe(signed);
  });

  it('skips a path-embedded HMAC (measured s2-ge.glbimg.com -> 400)', () => {
    const signed =
      'https://s2-ge.glbimg.com/R5J6vGb_jcQUK9mh9rSYCFHqXZo=/i.s3.glbimg.com/img-1-1170x650.jpg';
    expect(upgradeImageUrl(signed, HERO_TARGET_PX)).toBe(signed);
    expect(matchingRuleId(signed, HERO_TARGET_PX)).toBe('skipped-signed');
  });
});

describe('totality', () => {
  it.each([
    ['', ''],
    ['not a url', 'not a url'],
    ['://///', '://///'],
  ])('returns malformed input unchanged (%s)', (input, expected) => {
    expect(upgradeImageUrl(input, HERO_TARGET_PX)).toBe(expected);
  });

  it('handles null and undefined without throwing', () => {
    expect(upgradeImageUrl(null, HERO_TARGET_PX)).toBe('');
    expect(upgradeImageUrl(undefined, HERO_TARGET_PX)).toBe('');
    expect(matchingRuleId('', HERO_TARGET_PX)).toBeNull();
  });

  it('returns an unmatched URL BY REFERENCE, so callers can pointer-compare', () => {
    const plain = 'https://example.com/a.jpg';
    expect(upgradeImageUrl(plain, HERO_TARGET_PX)).toBe(plain);
    expect(matchingRuleId(plain, HERO_TARGET_PX)).toBeNull();
  });
});
