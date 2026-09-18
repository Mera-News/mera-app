import { buildRouterPrompt } from '../router-prompt';

/**
 * THE DEFECT THIS FILE EXISTS FOR.
 *
 * `router.md` is 1,835 tokens of decision procedure: the intent taxonomy, the
 * subject table, the tie-break ladders, the `facts/interest` catch-all. It was
 * parsed, budget-checked, compiled into `index.generated.ts` and NEVER SENT to
 * a model. The prompt the model actually received carried a four-line procedure
 * written inline in `router-prompt.ts`, ending "No row matches: answer briefly
 * and stop" -- and 90 of 308 route legs in G2d took that exit.
 *
 * Every test that could have caught it read the registry or the markdown. None
 * read the string that goes on the wire. These do.
 */
describe('the router prompt carries the router skill', () => {
  const prompt = buildRouterPrompt({ surface: 'CONFIG', languageName: 'English' });

  // Sentences that exist ONLY in router.md. If the body stops being composed,
  // these are the first things to disappear.
  it.each([
    ['the intent taxonomy', '## Step 1: intent'],
    ['the subject table', '| Subject | The turn is about |'],
    ['the interest catch-all', 'It is the catch-all and a real destination'],
    ['the chess rule', 'I enjoy playing chess'],
    ['the unconditional route', 'There is no such thing as a turn with no route'],
  ])('carries %s', (_label, needle) => {
    expect(prompt).toContain(needle);
  });

  it('does NOT carry the escape hatch that authorised the measured failure', () => {
    expect(prompt).not.toMatch(/no row matches/i);
    expect(prompt).not.toMatch(/answer briefly and stop/i);
  });

  it('names the context blocks the loop actually sends', () => {
    // The body described a `<context>` block that no leg has ever built. The
    // loop sends `<state>` and `<known_facts>`.
    expect(prompt).toContain('<state>');
    expect(prompt).toContain('<known_facts>');
    expect(prompt).not.toContain('<context>');
  });

  it('renders the skill index it tells the model to choose from', () => {
    expect(prompt).toContain('## Skill index');
    expect(prompt).toContain('- facts/interest:');
    // Destinations only: the router must not be a row of its own index, and a
    // topic guideline is reachable only by the background call.
    expect(prompt).not.toMatch(/^- router:/m);
    expect(prompt).not.toMatch(/^- topics\//m);
  });

  it('keeps the measured punctuation rule, which is not in the markdown', () => {
    expect(prompt).toContain('Never use an em dash');
  });
});
