// The finish event the stream reports: stop, tool_calls or length (a token-capped reply).
//
// CH1 (bug ledger, chat): a token-capped reply is reported as a plain stop, so a caller cannot tell a
// cut-off answer from a finished one. The client now reports `length`, streamed and buffered.
import { SMALL_MODEL } from '@/lib/llm/constants';
import { cloudChatStream } from '@/lib/llm/cloudComplete';
import { mockGateway, server } from '@/test/helpers';
import { captureChatBodies, collect, installChatHooks, MESSAGES, respond, textOf } from './support';

installChatHooks();

const run = () => collect(cloudChatStream({ messages: MESSAGES, model: SMALL_MODEL }));

describe('finish mapping', () => {
  it('stop is a stop, streamed, and the prompt never left the device in clear', async () => {
    const bodies = captureChatBodies();
    server.use(...mockGateway(respond({ chunks: ['Done.'], finishReason: 'stop' })));
    expect((await run()).pop()).toEqual({ type: 'finish', reason: 'stop' });
    expect(bodies).toHaveLength(1);
    expect(bodies[0]).not.toContain('SENTINEL');
  });

  it.each([
    ['streamed', false],
    ['buffered', true],
  ])('a provider tool_calls finish is a tool_calls finish, %s', async (_name, ignoreStream) => {
    server.use(...mockGateway(respond({ chunks: ['Calling.'], finishReason: 'tool_calls', ignoreStream })));
    const events = await run();
    expect(textOf(events)).toBe('Calling.');
    expect(events[events.length - 1]).toEqual({ type: 'finish', reason: 'tool_calls' });
  });
});

describe('CH1: a token-capped reply', () => {
  it('a token-capped stream reports finish reason length', async () => {
    server.use(...mockGateway(respond({ chunks: ['cut off mid-sen'], finishReason: 'length' })));
    const streamed = await run();
    expect(textOf(streamed)).toBe('cut off mid-sen');
    expect(streamed[streamed.length - 1]).toEqual({ type: 'finish', reason: 'length' });

    // The buffered path collapses it the same way (one ledger id, so the same test).
    server.use(...mockGateway(respond({ chunks: ['cut off mid-sen'], finishReason: 'length', ignoreStream: true })));
    const buffered = await run();
    expect(buffered[buffered.length - 1]).toEqual({ type: 'finish', reason: 'length' });
  });
});
