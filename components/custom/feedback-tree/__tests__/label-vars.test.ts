// label-vars.test.ts: {{publication}} in a tree label SAYS the display name
// (ux2 A7), while the context's `publicationName` stays the raw key.

import { feedbackLabelVars } from '../label-vars';

describe('feedbackLabelVars', () => {
  it('fills {{publication}} with the display name when there is one', () => {
    expect(
      feedbackLabelVars({ publicationName: '人民日报', publicationDisplayName: 'Renmin Ribao' }).publication,
    ).toBe('Renmin Ribao');
  });

  it('falls back to the raw name, then to empty', () => {
    expect(feedbackLabelVars({ publicationName: 'NOS' }).publication).toBe('NOS');
    expect(feedbackLabelVars({ publicationName: 'NOS', publicationDisplayName: '' }).publication).toBe('NOS');
    expect(feedbackLabelVars({}).publication).toBe('');
  });
});
