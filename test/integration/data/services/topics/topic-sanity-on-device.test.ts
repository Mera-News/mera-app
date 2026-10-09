// The weekly topic check (via persona-hygiene) never calls the cloud AI in on-device mode. It reports
// `skipped`, so the sweep withholds its cooldown stamp: a skip must not look like "ran and found nothing".
//
// Replaces topic-sanity-on-device.test.ts (1 `it`): returns skipped and makes no cloud call in
// on-device mode. That test mocked the database, the setting service and the cloud client; here the
// gate reads the real store and the real settings row, and "no cloud call" is the gateway mock
// recording nothing, with a cloud control that proves the same inputs DO reach it.
import { runSanityAudit } from '@/lib/database/services/topic-sanity-service';
import { ProcessingMode } from '@/lib/generated/graphql-types';
import { useMeraProtocolStore } from '@/lib/stores/mera-protocol-store';
import { advanceUntilDone, gatewayCalls, mockGateway, server, signInFixtureAccount, useFakeClock } from '@/test/helpers';

import { cleanupTopics, resetCloudMemory, resetTopicsMemory, seedFact, setMode } from './support';

beforeEach(async () => {
  resetTopicsMemory();
  resetCloudMemory();
  await signInFixtureAccount();
});
afterEach(cleanupTopics);

const SKIPPED = { incoherentFacts: [], audited: 0, skipped: true };

async function audit() {
  const { fact } = await seedFact('Follows Indian cricket', ['India cricket news', 'Amsterdam cricket festival music tech']);
  return advanceUntilDone(runSanityAudit({ facts: [{ id: fact.id, statement: fact.statement }] }));
}

describe('runSanityAudit in on-device mode', () => {
  it('returns skipped and makes no cloud call when the store says on-device', async () => {
    await setMode('on-device');
    useFakeClock(Date.parse('2026-10-09T10:00:00Z'));

    expect(await audit()).toEqual(SKIPPED);
    expect(gatewayCalls()).toHaveLength(0);
  });

  it('returns skipped when only the persisted setting says on-device (the store still holds its cloud default)', async () => {
    await setMode('on-device');
    // The store before hydration: cloud default, the row already says on-device.
    useMeraProtocolStore.setState({ processingMode: ProcessingMode.Cloud });
    useFakeClock(Date.parse('2026-10-09T10:00:00Z'));

    expect(await audit()).toEqual(SKIPPED);
    expect(gatewayCalls()).toHaveLength(0);
  });

  it('control: in cloud mode the same inputs DO reach the gateway, and the run is not "skipped"', async () => {
    server.use(...mockGateway(() => '[]'));
    useFakeClock(Date.parse('2026-10-09T10:00:00Z'));

    const out = await audit();

    expect(gatewayCalls().length).toBeGreaterThan(0);
    expect(out.skipped).toBe(false);
  });
});
