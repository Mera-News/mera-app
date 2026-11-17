// lib/llm/prewarm.ts against the gateway mock: what a launch really sends. Real attestation fetches,
// real JWT, real limiter, real cloudComplete. A chat open (`ping`) sends the readiness ping every time
// and drives the header badge's status; app launch (no `ping`) warms attestation and the JWT only.
// Every test runs on its own fake date, three hours after the last, so no client cache carries over.
import { getJwtToken, invalidateJwtCache } from '@/lib/auth-client';
import { ProcessingMode } from '@/lib/generated/graphql-types';
import { prewarmCloudChat, useChatReadiness } from '@/lib/llm/prewarm';
import { useCloudChatStore } from '@/lib/stores/cloud-chat-store';
import { useMeraProtocolStore } from '@/lib/stores/mera-protocol-store';
import { useUserStore } from '@/lib/stores/user-store';
import {
  attestationRequests,
  gatewayCalls,
  http,
  HttpResponse,
  server,
} from '@/test/helpers';
import { useStrictClock } from '@/test/integration/chat/_helpers';
import {
  drive,
  installChatHooks,
} from './support';

installChatHooks();

let clock = Date.UTC(2026, 9, 9);
beforeEach(() => {
  clock += 3 * 3600_000;
  useStrictClock(clock);
  useChatReadiness.setState({ status: 'idle' });
});
afterEach(() => {
  useMeraProtocolStore.setState({ processingMode: ProcessingMode.Cloud, chatInCloud: false });
  useCloudChatStore.getState().reset();
  useUserStore.setState({ userPersona: null });
});
async function quiet(ms = 20_000): Promise<void> {
  for (let t = 0; t < ms; t += 500) {
    await jest.advanceTimersByTimeAsync(500);
    await new Promise((r) => setImmediate(r));
  }
}

describe('prewarmCloudChat, the cases where it stays quiet', () => {
  it('a token endpoint that errors reads as no credential: nothing is sent, nothing throws', async () => {
    invalidateJwtCache();
    server.use(http.get('*/api/auth/token', () => new HttpResponse('boom', { status: 500 })));
    await expect(drive(getJwtToken())).resolves.toBeNull();
    expect(() => prewarmCloudChat({ ping: true })).not.toThrow();
    await quiet();
    expect(gatewayCalls()).toEqual([]);
    expect(attestationRequests()).toBe(0);
  });
});
