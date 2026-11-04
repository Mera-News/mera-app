import { factRemovedReplyOk } from '@/lib/mera-harness/core/fact-removed-turn';

const F = ['30 year old male'];

describe('factRemovedReplyOk', () => {
  it.each([
    ['I removed "30 year old male" because I couldn\'t turn it into news topics. What would you like me to save instead?'],
    ['I removed "30 year old male" because it describes you rather than a subject the news covers. What should I save instead?'],
    ['मैंने "30 year old male" हटा दिया क्योंकि मुझे इसके लिए समाचार विषय नहीं मिले। इसके बजाय मैं क्या सहेजूँ?'],
  ])('passes a true sentence: %s', (reply) => {
    expect(factRemovedReplyOk(reply, F)).toBe(true);
  });

  it('fails Hindi written in Latin letters', () => {
    const reply = 'Maine "30 year old male" hata diya. Main kya save karun?';
    expect(factRemovedReplyOk(reply, F, 'Hindi')).toBe(false);
    expect(factRemovedReplyOk(reply, F, 'Dutch')).toBe(true);
  });

  it('fails English when the reader reads Dutch', () => {
    const english = 'I removed "30 year old male". What would you like me to save instead?';
    expect(factRemovedReplyOk(english, F, 'Dutch')).toBe(false);
    expect(factRemovedReplyOk(english, F, 'English')).toBe(true);
    expect(factRemovedReplyOk('Ik heb "30 year old male" verwijderd. Wat wil je dat ik opsla?', F, 'Dutch')).toBe(true);
  });

  it.each([
    [''],
    ['I removed something. What should I save instead?'],
    ['I removed "30 year old male".'],
    ['I removed "30 year old male" and saved your age. What else?'],
    ['deleteUserFacts removed "30 year old male". What should I save?'],
  ])('fails: %s', (reply) => {
    expect(factRemovedReplyOk(reply, F)).toBe(false);
  });
});
