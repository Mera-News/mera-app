// The three card tools on the device port: they delegate to the engine's executeTool, hand side effects to
// the engine's sinks, refuse a typed apply for a card only a tap may apply, and go quiet after Stop.
import { makeAgentDeps, makeAgentToolPort, type CardToolDeps } from '@/lib/chat-tools/agent-device-port';
import { userTapOnlyRefusal } from '@/lib/news-harness/core/proposals';
import { signInFixtureAccount } from '@/test/helpers';
import { resetChatModules } from '@/test/integration/chat/_helpers';

jest.setTimeout(30_000);

beforeEach(async () => {
  resetChatModules();
  await signInFixtureAccount();
});

function cards(appliable: boolean) {
  const execute = jest.fn(async (name: string) => ({
    result: { ran: name },
    sideEffects: { proposalResolved: 'applied' as const },
  }));
  const onSideEffects = jest.fn();
  const deps: CardToolDeps = {
    execute,
    onSideEffects,
    pending: () => ({ id: 'p-1', summary: 's', chooseOne: false, appliable }),
  };
  return { deps, execute, onSideEffects };
}

describe('card tools on the device port', () => {
  it('are absent without engine hooks', () => {
    const port = makeAgentToolPort('msg');
    expect(port.proposeChanges).toBeUndefined();
    expect(port.applyProposal).toBeUndefined();
    expect(port.cancelProposal).toBeUndefined();
  });

  it('delegate to executeTool by name and hand the side effects to the sinks', async () => {
    const { deps, execute, onSideEffects } = cards(true);
    const port = makeAgentToolPort('msg', undefined, deps);

    expect(await port.proposeChanges!({ explanation: 'x' })).toEqual({ ran: 'proposeChanges' });
    expect(await port.applyProposal!()).toEqual({ ran: 'applyProposal' });
    expect(await port.cancelProposal!()).toEqual({ ran: 'cancelProposal' });

    expect(execute.mock.calls).toEqual([['proposeChanges', { explanation: 'x' }], ['applyProposal', {}], ['cancelProposal', {}]]);
    expect(onSideEffects).toHaveBeenCalledTimes(3);
    expect(onSideEffects).toHaveBeenCalledWith({ proposalResolved: 'applied' });
  });

  it('refuses a typed apply when only a tap may apply the card, and calls nothing', async () => {
    const { deps, execute, onSideEffects } = cards(false);
    const port = makeAgentToolPort('msg', undefined, deps);

    expect(await port.applyProposal!()).toEqual(userTapOnlyRefusal());
    expect(execute).not.toHaveBeenCalled();
    expect(onSideEffects).not.toHaveBeenCalled();
    // Cancel is always allowed.
    await port.cancelProposal!();
    expect(execute).toHaveBeenCalledWith('cancelProposal', {});
  });

  it('answer stopped on all three after Stop, without touching the engine', async () => {
    const { deps, execute } = cards(true);
    const stop = new AbortController();
    const { tools } = makeAgentDeps('msg', jest.fn(), undefined, stop.signal, deps);
    stop.abort();

    expect(await tools.proposeChanges!({})).toEqual({ error: 'stopped' });
    expect(await tools.applyProposal!()).toEqual({ error: 'stopped' });
    expect(await tools.cancelProposal!()).toEqual({ error: 'stopped' });
    expect(execute).not.toHaveBeenCalled();
  });
});
