import { SAMPLE_LISTS, sampleLines, sampleProfile, sampleStories } from '@/components/custom/floating-chat/chat-samples';

const { LIVE, WORK, FROM, TRAVEL, SPORTS, MUSIC, INTERESTS, STORIES } = SAMPLE_LISTS;

describe('chat samples', () => {
  it('a profile is six lines in slot order: home, work, roots or a trip, sport, music, interest', () => {
    for (let seed = 0; seed < 300; seed++) {
      const p = sampleProfile(seed);
      expect(p).toHaveLength(6);
      expect(LIVE).toContain(p[0]);
      expect(WORK).toContain(p[1]);
      expect([...FROM, ...TRAVEL]).toContain(p[2]);
      expect(SPORTS).toContain(p[3]);
      expect(MUSIC).toContain(p[4]);
      expect(INTERESTS).toContain(p[5]);
    }
  });

  it('the same seed gives the same sample, and seeds vary it', () => {
    expect(sampleProfile(42)).toEqual(sampleProfile(42));
    expect(sampleLines('stories', 7)).toEqual(sampleStories(7));
    const distinct = new Set(Array.from({ length: 20 }, (_, i) => sampleProfile(i * 97).join('|')));
    expect(distinct.size).toBeGreaterThan(15);
  });

  it('stories are five distinct names from the list', () => {
    for (let seed = 0; seed < 300; seed++) {
      const s = sampleStories(seed);
      expect(new Set(s).size).toBe(5);
      s.forEach((name) => expect(STORIES).toContain(name));
    }
  });

  it('profile lines never name a followed thing ("I follow") and no line carries a dash', () => {
    const profile = [...LIVE, ...WORK, ...FROM, ...TRAVEL, ...SPORTS, ...MUSIC, ...INTERESTS];
    profile.forEach((line) => expect(line).not.toMatch(/\bI follow\b/i));
    [...profile, ...STORIES].forEach((line) => expect(line).not.toMatch(/[–—]/));
  });
});
