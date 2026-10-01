// Unit tests for the pure story export shaping.
//
// The fixture mixes the shapes a real story holds, so it cannot pass
// vacuously: a member WITH a retention row (link + note), one whose retention
// row has an empty reason (kept while its note was still pending), one with no
// retention row at all (followed before retention existed), a member whose
// pubDateMs is 0 (a snapshot with no date), and a note with an embedded newline.

import {
  buildStoryJson,
  buildStoryMarkdown,
  toStoryExportRows,
  type StoryExportLabels,
  type StoryExportMember,
  type StoryRetainedRow,
} from '../story-export';

const MEMBERS: StoryExportMember[] = [
  {
    articleId: 'a1',
    title: 'Dike repair  starts\nin Hoorn',
    pubDateMs: Date.UTC(2026, 8, 23, 9, 0, 0),
    publicationName: 'NOS',
    languageCode: 'nl',
    countryCode: 'NL',
    imageUrl: 'https://nos.nl/a1.jpg',
  },
  {
    articleId: 'a2',
    title: 'Water board budget approved',
    pubDateMs: Date.UTC(2026, 8, 22, 14, 30, 0),
    publicationName: 'NH Nieuws',
    languageCode: 'fy',
  },
  {
    articleId: 'a3',
    title: 'Old coverage from before retention',
    pubDateMs: 0,
  },
];

const RETAINED = new Map<string, StoryRetainedRow>([
  [
    'a1',
    {
      article_url: 'https://nos.nl/a1',
      reason: 'You live in Hoorn,\nwhere the works start.',
      title_en: 'Dike repair starts in Hoorn',
      image_url: 'https://nos.nl/retained-a1.jpg',
    },
  ],
  [
    'a2',
    {
      article_url: 'https://nhnieuws.nl/a2',
      reason: '',
      title_en: null,
      image_url: 'https://nhnieuws.nl/a2.jpg',
    },
  ],
]);

const LABELS: StoryExportLabels = {
  headline: 'Hoorn dike repairs',
  headlineAiLabel: 'AI-generated',
  docExported: 'Exported 2026-09-24',
  reasonLabel: 'Why Mera picked it',
  languageName: (code) => (code === 'nl' ? 'Dutch' : null),
};

describe('toStoryExportRows', () => {
  it('joins each member with its retention row, in the order given', () => {
    const rows = toStoryExportRows(MEMBERS, RETAINED, { includeReason: true, includeImage: false });

    expect(rows.map((r) => r.title)).toEqual([
      'Dike repair starts in Hoorn',
      'Water board budget approved',
      'Old coverage from before retention',
    ]);
    expect(rows[0]).toEqual({
      title: 'Dike repair starts in Hoorn',
      publication: 'NOS',
      country: 'NL',
      language: 'nl',
      url: 'https://nos.nl/a1',
      publishedAt: '2026-09-23T09:00:00.000Z',
      reason: 'You live in Hoorn, where the works start.',
      imageUrl: null,
    });
  });

  it('exports images on request, snapshot first, retention row as fallback', () => {
    const rows = toStoryExportRows(MEMBERS, RETAINED, {
      includeReason: false,
      includeImage: true,
    });
    expect(rows.map((r) => r.imageUrl)).toEqual([
      'https://nos.nl/a1.jpg',
      'https://nhnieuws.nl/a2.jpg',
      null,
    ]);
  });

  it('exports a member with no retention row, minus its link and note', () => {
    const [, , old] = toStoryExportRows(MEMBERS, RETAINED, { includeReason: true, includeImage: false });
    expect(old.url).toBeNull();
    expect(old.reason).toBeNull();
    expect(old.publication).toBeNull();
  });

  it('treats a zero pubDateMs as unknown, never 1970', () => {
    const [, , old] = toStoryExportRows(MEMBERS, RETAINED, { includeReason: true, includeImage: false });
    expect(old.publishedAt).toBeNull();
  });

  it('gives an empty retained reason as null, not an empty string', () => {
    const [, pending] = toStoryExportRows(MEMBERS, RETAINED, { includeReason: true, includeImage: false });
    expect(pending.url).toBe('https://nhnieuws.nl/a2');
    expect(pending.reason).toBeNull();
  });

  it('drops every reason when the reader turned them off', () => {
    const rows = toStoryExportRows(MEMBERS, RETAINED, { includeReason: false, includeImage: false });
    expect(rows.every((r) => r.reason === null)).toBe(true);
    // The link is not a reason and survives the toggle.
    expect(rows[0].url).toBe('https://nos.nl/a1');
  });

  it('falls back to the retained English title when the snapshot title is blank', () => {
    const rows = toStoryExportRows(
      [{ articleId: 'a1', title: '   ', pubDateMs: 1 }],
      RETAINED,
      { includeReason: true, includeImage: false },
    );
    expect(rows[0].title).toBe('Dike repair starts in Hoorn');
  });
});

describe('buildStoryMarkdown', () => {
  const rows = toStoryExportRows(MEMBERS, RETAINED, { includeReason: true, includeImage: false });

  it('titles the document with the headline and labels an AI headline', () => {
    const md = buildStoryMarkdown(rows, LABELS);
    expect(md.startsWith('# Hoorn dike repairs\n\n_AI-generated_\n\nExported 2026-09-24\n')).toBe(
      true,
    );
  });

  it('omits the AI line for a headline the reader did not get from Mera', () => {
    const md = buildStoryMarkdown(rows, { ...LABELS, headlineAiLabel: undefined });
    expect(md).not.toContain('AI-generated');
    expect(md.startsWith('# Hoorn dike repairs\n\nExported 2026-09-24\n')).toBe(true);
  });

  it('writes one section per article with its meta, link and note', () => {
    const md = buildStoryMarkdown(rows, LABELS);
    expect(md).toContain(
      '## Dike repair starts in Hoorn\nNOS · 2026-09-23 · Dutch\nhttps://nos.nl/a1\n\n> Why Mera picked it: You live in Hoorn, where the works start.',
    );
    // An unknown code prints as the code.
    expect(md).toContain('NH Nieuws · 2026-09-22 · fy\n');
    expect(md).not.toContain('![]');
    // No note, so no quote block; no date or publication, so no meta line.
    expect(md).toContain('## Old coverage from before retention\n');
    expect(md.match(/> Why Mera picked it/g)).toHaveLength(1);
  });

  it('writes an image line after the link when images are on', () => {
    const withImages = toStoryExportRows(MEMBERS, RETAINED, {
      includeReason: false,
      includeImage: true,
    });
    const md = buildStoryMarkdown(withImages, LABELS);
    expect(md).toContain('https://nos.nl/a1\n![](https://nos.nl/a1.jpg)\n');
    expect(md.match(/!\[\]/g)).toHaveLength(2);
  });
});

describe('buildStoryJson', () => {
  it('carries the story, the count and the reader answer on reasons', () => {
    const rows = toStoryExportRows(MEMBERS, RETAINED, { includeReason: true, includeImage: false });
    const payload = JSON.parse(
      buildStoryJson(
        rows,
        { headline: 'Hoorn dike repairs', headlineAiGenerated: true },
        { includeReason: true, includeImage: false },
        new Date(Date.UTC(2026, 8, 24, 8, 0, 0)),
      ),
    );
    expect(payload.exportedAt).toBe('2026-09-24T08:00:00.000Z');
    expect(payload.story).toEqual({ headline: 'Hoorn dike repairs', headlineAiGenerated: true });
    expect(payload.count).toBe(3);
    expect(payload.includesReason).toBe(true);
    expect(payload.includesImage).toBe(false);
    expect(payload.articles[2]).toEqual({
      title: 'Old coverage from before retention',
      publication: null,
      country: null,
      language: null,
      url: null,
      publishedAt: null,
      reason: null,
      imageUrl: null,
    });
  });
});
