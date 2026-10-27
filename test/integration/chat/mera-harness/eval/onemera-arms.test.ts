// The onemera step arms send what they claim: a step's control and candidate build DIFFERENT leg-0
// router prompts, and the control and its twin build the SAME one (their spread is the floor).
import { createHash } from 'node:crypto';
import { resetAgentArmsForTest } from '@/lib/mera-harness/core/arms';
import { buildRouterPrompt } from '@/lib/mera-harness/core/router-prompt';
import { ensureOnemeraArms } from '@/lib/mera-harness/eval/onemera-arms';

beforeEach(() => ensureOnemeraArms());
afterEach(() => resetAgentArmsForTest());

const leg0 = (arm: string): string =>
  createHash('sha256')
    .update(['CONFIG', 'ONBOARDING'].map((surface) => buildRouterPrompt({ surface: surface as 'CONFIG', languageName: 'English', arm })).join('\n'))
    .digest('hex');

describe.each([
  ['pre-S1', 'pre-S1-twin', 'S1'],
  ['pre-S1.5', 'pre-S1.5-twin', 'S1.5'],
  ['pre-S3', 'pre-S3-twin', 'S3'],
])('%s / %s / %s', (control, twin, candidate) => {
  it('the control and its twin send the same leg-0 router prompt', () => {
    expect(leg0(twin)).toBe(leg0(control));
  });

  it('the candidate sends a different one', () => {
    expect(leg0(candidate)).not.toBe(leg0(control));
  });
});

it('pre-S1 hides feed-tuning and S1 routes to it', () => {
  expect(buildRouterPrompt({ surface: 'CONFIG', arm: 'pre-S1' })).not.toContain('conversation/feed-tuning');
  expect(buildRouterPrompt({ surface: 'CONFIG', arm: 'S1' })).toContain('| feed_tuning | `conversation/feed-tuning` |');
});

it('pre-S3 hides follow-story and S3 routes to it, keeping a stated "I follow X" an interest', () => {
  expect(buildRouterPrompt({ surface: 'CONFIG', arm: 'pre-S3' })).not.toContain('conversation/follow-story');
  const s3 = buildRouterPrompt({ surface: 'CONFIG', arm: 'S3' });
  expect(s3).toContain('| follow_story | `conversation/follow-story` |');
  expect(s3).toContain('follow it is follow_story.');
  expect(s3).toContain('is **new_fact** interest');
});
