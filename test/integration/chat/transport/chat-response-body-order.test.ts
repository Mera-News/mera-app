// MERA-APP-8X: expo/fetch starts native streaming the moment `response.body` is read, which
// empties the buffer a later `text()` reads. A non-event-stream reply must never touch `.body`.
import { consumeChatResponse } from '@/lib/llm/chat-response';
import { TEST_MODEL_KEYS } from '@/test/mock-backend/gateway/keys';
import { sealForClient } from '@/test/mock-backend/gateway/crypto';

const { secret, publicKeyHex } = TEST_MODEL_KEYS.ed25519;
const seal = (t: string) => sealForClient(t, publicKeyHex, 'ed25519');

async function textOf(response: Response): Promise<string> {
  let out = '';
  for await (const e of consumeChatResponse(response, secret, 'ed25519', [])) {
    if (e.type === 'text-delta') out += e.delta;
  }
  return out;
}

describe('consumeChatResponse reads the body only for event streams', () => {
  it('a JSON reply is decrypted even though reading .body would drain text()', async () => {
    const json = JSON.stringify({
      choices: [{ message: { content: seal('hello there') }, finish_reason: 'stop' }],
    });
    let drained = false;
    const fake = {
      headers: new Headers({ 'content-type': 'application/json' }),
      get body() {
        drained = true; // expo/fetch: the first read starts native streaming
        return new ReadableStream();
      },
      text: async () => (drained ? '' : json),
    } as unknown as Response;

    expect(await textOf(fake)).toBe('hello there');
  });

  it('an event-stream reply still streams', async () => {
    const frame = (o: object) => `data: ${JSON.stringify(o)}\n\n`;
    const sse =
      frame({ choices: [{ index: 0, delta: { content: seal('streamed') } }] }) +
      frame({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }) +
      'data: [DONE]\n\n';
    const response = new Response(sse, { headers: { 'content-type': 'text/event-stream' } });

    expect(await textOf(response)).toBe('streamed');
  });
});
