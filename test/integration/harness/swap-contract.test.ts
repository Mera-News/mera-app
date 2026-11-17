// The app runs on mera-news-client through thin re-export shims and one platform host. These checks
// fail if a shim grows logic or the host stops registering before client modules load.
import fs from 'fs';
import path from 'path';

const ROOT = path.resolve(__dirname, '../../..');

const SHIMS = [
  ...[
    'agent-registry',
    'derive-fact-cards',
    'derive-proposals',
    'fact-choice-actions',
    'topic-plan-actions',
    'topic-plan-resolution',
    'track-card-actions',
    'track-options',
    'types',
  ].map((n) => `components/custom/floating-chat/${n}.ts`),
  'components/custom/mera-button/open-mera-chat.ts',
  ...['feed-entries', 'not-read-tail', 'swipe-callbacks'].map((n) => `components/custom/feed/${n}.ts`),
  ...['note-pending-mode', 'feedback-subject'].map((n) => `components/custom/cards/${n}.ts`),
  'components/custom/config-mera/clear-feed-cache.ts',
  'lib/hooks/useCloudPersonaChat.ts',
  'lib/llm/text-tool-protocol.ts',
  'lib/chat-tools/mera-explainer-content.ts',
];

const REEXPORT = /^export \* from '@\/lib\/[^']+';$/;
const COMMENT = /^(\/\/|\/\*|\*)/;
// The one shim that also owns an app-side React context.
const CONTEXT_SHIM = 'components/custom/floating-chat/types.ts';
const CONTEXT_LINES = [
  "import { createContext } from 'react';",
  'export const OnboardingChatContext = createContext(false);',
];

describe('shims hold only a re-export', () => {
  it('lists 19 shims', () => expect(SHIMS).toHaveLength(19));

  it.each(SHIMS)('%s', (rel) => {
    const lines = fs
      .readFileSync(path.join(ROOT, rel), 'utf8')
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean);
    const extra = rel === CONTEXT_SHIM ? CONTEXT_LINES : [];
    const stray = lines.filter((l) => !COMMENT.test(l) && !REEXPORT.test(l) && !extra.includes(l));
    expect(stray).toEqual([]);
    expect(lines.some((l) => REEXPORT.test(l))).toBe(true);
    if (rel === CONTEXT_SHIM) for (const l of CONTEXT_LINES) expect(lines).toContain(l);
  });
});

describe('app host', () => {
  it('registers before a client module reads a facade at load', () => {
    expect(() =>
      jest.isolateModules(() => {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        require('@/lib/app-host');
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        require('@/lib/config/endpoints');
      }),
    ).not.toThrow();
  });

  it('without the host, that client module throws PlatformNotRegisteredError', () => {
    let error: unknown;
    jest.isolateModules(() => {
      try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        require('@/lib/config/endpoints');
      } catch (e) {
        error = e;
      }
    });
    expect((error as Error | undefined)?.name).toBe('PlatformNotRegisteredError');
  });
});
