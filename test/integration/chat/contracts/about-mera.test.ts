import fs from 'fs';
import path from 'path';

import en from '@/lib/locales/en.json';

const read = (f: string) =>
  fs.readFileSync(path.join(__dirname, '../../../../components/custom/floating-chat', f), 'utf8');

describe('About Mera carries the Art. 50 notice', () => {
  it('has the title, the three sentence parts and the mistakes line in en.json', () => {
    const { aboutTitle, guidelinesBefore, guidelinesLink, guidelinesAfter, mayMistakes } =
      en.floatingChat;
    for (const text of [aboutTitle, guidelinesBefore, guidelinesLink, guidelinesAfter, mayMistakes]) {
      expect(typeof text).toBe('string');
      expect(text.length).toBeGreaterThan(0);
    }
  });

  it('the modal titles itself and draws the sentence, the link and the mistakes line', () => {
    const src = read('AboutMeraModal.tsx');
    for (const key of ['aboutTitle', 'guidelinesBefore', 'guidelinesLink', 'guidelinesAfter', 'mayMistakes']) {
      expect(src).toContain(`t('floatingChat.${key}')`);
    }
    expect(src).toContain('testID="chat-guidelines"');
    expect(src).toContain('testID="chat-guidelines-link"');
  });
});

describe('the disclosure lives in the header, not the thread', () => {
  it('ChatThread no longer draws the banner', () => {
    const src = read('ChatThread.tsx');
    expect(src).not.toContain('chat-guidelines');
    expect(src).not.toContain('guidelinesBefore');
  });

  it('the header shows the subtitle and opens About Mera from the title block', () => {
    const src = read('ChatPopover.tsx');
    expect(src).toContain('floatingChat.aiSubtitle');
    expect(src).toContain('AboutMeraModal');
    // tap and swipe-down share one detector
    expect(src).toMatch(/Gesture\.Race\(\s*swipeDownGesture/);
  });
});
