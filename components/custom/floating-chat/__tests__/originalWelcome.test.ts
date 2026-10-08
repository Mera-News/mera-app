import en from '@/lib/locales/en.json';
import { awaitsFactsRead, usesOriginalWelcome } from '../original-welcome';
import { chatContextFor, introKeyFor } from '@/components/custom/mera-button/mera-pages';

describe('original welcome entry rule', () => {
  it('Profile gets the welcome with or without facts', () => {
    const ctx = chatContextFor('profile');
    for (const has of [true, false, null]) expect(usesOriginalWelcome(ctx, has)).toBe(true);
  });

  it('Feed with no facts gets the welcome', () => {
    expect(usesOriginalWelcome(chatContextFor('feed'), false)).toBe(true);
  });

  it('Feed with a fact keeps the page opener', () => {
    expect(usesOriginalWelcome(chatContextFor('feed'), true)).toBe(false);
    expect(introKeyFor('feed', true)).toBe('meraIntro.feed');
  });

  it('Feed waits for the facts read, other pages never wait', () => {
    expect(awaitsFactsRead(chatContextFor('feed'), null)).toBe(true);
    expect(awaitsFactsRead(chatContextFor('feed'), false)).toBe(false);
    expect(awaitsFactsRead(chatContextFor('world'), null)).toBe(false);
    expect(usesOriginalWelcome(chatContextFor('feed'), null)).toBe(false);
  });

  it('other entries keep the page opener whatever the facts', () => {
    for (const page of ['world', 'facts', 'sources', 'settings'] as const) {
      for (const has of [true, false]) {
        expect(usesOriginalWelcome(chatContextFor(page), has)).toBe(false);
      }
    }
    expect(usesOriginalWelcome({ kind: 'persona' }, false)).toBe(false);
  });

  it('the original welcome and its four chips exist in en', () => {
    expect(
      en.personaChat.introMessage.startsWith("Hi, I'm Mera, your personal news assistant."),
    ).toBe(true);
    expect([
      en.floatingChat.chipAddLocation,
      en.floatingChat.chipShowFacts,
      en.floatingChat.chipHelpSetup,
      en.floatingChat.chipDataHandling,
    ]).toEqual(['Add where I live', 'Show my facts', 'Help me set up', 'How is my data handled?']);
  });
});
