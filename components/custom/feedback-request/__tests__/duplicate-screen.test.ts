import { isDuplicateFeedbackRequestScreen } from '../duplicate-screen';

const ID = '0123456789abcdef01234567';
const tab = { key: 't', name: 'app_container' };
const fb = (key: string, id: string) => ({ key, name: 'feedback-request', params: { id } });

describe('isDuplicateFeedbackRequestScreen', () => {
  it('true when the screen right below is the same question', () => {
    expect(isDuplicateFeedbackRequestScreen({ routes: [tab, fb('a', ID), fb('b', ID)] }, 'b', ID)).toBe(true);
  });

  it('false for the first copy, another question, or another screen below', () => {
    const state = { routes: [tab, fb('a', ID), fb('b', 'ffffffffffffffffffffffff')] };
    expect(isDuplicateFeedbackRequestScreen(state, 'a', ID)).toBe(false);
    expect(isDuplicateFeedbackRequestScreen(state, 'b', 'ffffffffffffffffffffffff')).toBe(false);
    expect(isDuplicateFeedbackRequestScreen({ routes: [fb('a', ID)] }, 'a', ID)).toBe(false);
  });

  it('false without a state, an unknown key or a missing id', () => {
    expect(isDuplicateFeedbackRequestScreen(undefined, 'b', ID)).toBe(false);
    expect(isDuplicateFeedbackRequestScreen({ routes: [fb('a', ID), fb('b', ID)] }, 'zz', ID)).toBe(false);
    expect(isDuplicateFeedbackRequestScreen({ routes: [fb('a', ID), fb('b', ID)] }, 'b', undefined)).toBe(false);
  });
});
