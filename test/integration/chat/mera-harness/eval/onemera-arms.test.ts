// The shipped router is the last measured body, byte for byte, and the body before
// it (the next step's control) still differs from it.
import { createHash } from 'node:crypto';
import { registerAgentArm, resetAgentArmsForTest } from '@/lib/mera-harness/core/arms';
import { buildRouterPrompt } from '@/lib/mera-harness/core/router-prompt';
import { loadSkill } from '@/lib/mera-harness/core/skill-loader';
import { S3B_ROUTER_BODY, S3_ROUTER_BODY } from '@/lib/mera-harness/eval/onemera-arms';

afterEach(() => resetAgentArmsForTest());

const leg0 = (arm?: string): string =>
  createHash('sha256')
    .update(['CONFIG', 'ONBOARDING'].map((surface) => buildRouterPrompt({ surface: surface as 'CONFIG', languageName: 'English', arm })).join('\n'))
    .digest('hex');

it('router.md is the S3b body that was measured, byte for byte', () => {
  expect(loadSkill('router')?.trim()).toBe(S3B_ROUTER_BODY.trim());
  expect(S3B_ROUTER_BODY).toContain('a yes, a thanks or a single word is never follow_story');
});

it('the S3 body, the next control, still builds a different leg-0 prompt', () => {
  registerAgentArm({ id: 'next-control', description: 'control', routerBody: S3_ROUTER_BODY });
  expect(leg0('next-control')).not.toBe(leg0());
});
