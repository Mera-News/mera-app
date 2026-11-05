import { SAMPLE_LISTS, sampleLines, sampleProfile, sampleStories } from '@/components/custom/floating-chat/chat-samples';

const { LIVE, WORK, FROM, TRAVEL, PLANS, HOME, PEOPLE, STORIES } = SAMPLE_LISTS;

describe('chat samples', () => {
  it('a profile is six lines in slot order: where they live, work, roots or a trip, plan, home, people', () => {
    for (let seed = 0; seed < 300; seed++) {
      const p = sampleProfile(seed);
      expect(p).toHaveLength(6);
      expect(LIVE).toContain(p[0]);
      expect(WORK).toContain(p[1]);
      expect([...FROM, ...TRAVEL]).toContain(p[2]);
      expect(PLANS).toContain(p[3]);
      expect(HOME).toContain(p[4]);
      expect(PEOPLE).toContain(p[5]);
    }
  });

  it('the same seed gives the same sample, and seeds vary it', () => {
    expect(sampleProfile(42)).toEqual(sampleProfile(42));
    expect(sampleLines('stories', 7)).toEqual(sampleStories(7));
    const distinct = new Set(Array.from({ length: 20 }, (_, i) => sampleProfile(i * 97).join('|')));
    expect(distinct.size).toBeGreaterThan(15);
  });

  it('consecutive samples (seeds 97 apart, as ChatSample steps) change their first line', () => {
    const base = 51234;
    const homes = new Set(Array.from({ length: 10 }, (_, i) => sampleProfile(base + i * 97)[0]));
    const firstStories = new Set(Array.from({ length: 10 }, (_, i) => sampleStories(base + i * 97)[0]));
    expect(homes.size).toBeGreaterThan(6);
    expect(firstStories.size).toBeGreaterThan(6);
  });

  it('stories are five distinct names from the list', () => {
    for (let seed = 0; seed < 300; seed++) {
      const s = sampleStories(seed);
      expect(new Set(s).size).toBe(5);
      s.forEach((name) => expect(STORIES).toContain(name));
    }
  });

  it('profile lines say what affects the reader, never what they only like, and no line carries a dash', () => {
    const profile = [...LIVE, ...WORK, ...FROM, ...TRAVEL, ...PLANS, ...HOME, ...PEOPLE];
    profile.forEach((line) => expect(line).not.toMatch(/\bI follow\b|\bI(’m| am) into\b|\bI (love|like)\b/i));
    [...profile, ...STORIES].forEach((line) => expect(line).not.toMatch(/[–—]/));
  });

  it('the new slots stay short: a set shows only once every line has translated', () => {
    [...PLANS, ...HOME, ...PEOPLE].forEach((line) => expect(line.length).toBeLessThanOrEqual(36));
  });
});
