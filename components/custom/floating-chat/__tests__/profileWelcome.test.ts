import en from '@/lib/locales/en.json';
import { usesProfileWelcome } from '../profile-welcome';
import { chatContextFor, introKeyFor } from '@/components/custom/mera-button/mera-pages';

describe('Profile entry greets with the original welcome', () => {
  it('profile persona context uses the original welcome', () => {
    expect(usesProfileWelcome(chatContextFor('profile'))).toBe(true);
  });

  it('feed, world, facts and article entries keep the page opener', () => {
    for (const page of ['feed', 'world', 'facts', 'sources', 'settings'] as const) {
      expect(usesProfileWelcome(chatContextFor(page))).toBe(false);
    }
    expect(introKeyFor('feed', true)).toBe('meraIntro.feed');
    expect(usesProfileWelcome({ kind: 'persona' })).toBe(false);
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
