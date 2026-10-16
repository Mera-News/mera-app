// Cards on the cloud persona loop, driven the way the app drives them: a scripted gateway, the real
// engine, the real PersonaUpdateAgent executing proposeChanges / applyProposal / cancelProposal.
import { stopChatTurn } from '@/lib/chat-session/chat-session';
import { __resetForTests as resetFallback } from '@/lib/llm/model-fallback';
import { pendingProposalView } from '@/lib/chat-session/cloud-engine-helpers';
import { useFloatingChatStore } from '@/lib/stores/floating-chat-store';
import { gatewayCalls, mockGateway, server, signInFixtureAccount, type GatewayCall, type GatewayResponder } from '@/test/helpers';
import { hasToolResult, isRouteLeg, personMessage, reply, resetChatModules, systemOf, toolCall, until } from '@/test/integration/chat/_helpers';
import { attachCloud, idle, settle, turnDone } from './kit';

jest.setTimeout(60_000);

afterEach(settle);

beforeEach(async () => {
  resetChatModules();
  resetFallback();
  await signInFixtureAccount();
  useFloatingChatStore.setState({ isExpanded: true, proposal: null, resolvedProposals: {} });
});

const store = () => useFloatingChatStore.getState();
const STAGE = toolCall('proposeChanges', {
  explanation: 'Hides gossip stories.',
  expected_effects: 'Fewer gossip stories.',
  actions: [{ type: 'add_suppression', suppressionPattern: 'celebrity gossip', suppressionStrength: 0.9 }],
});
const route = reply('One moment.', toolCall('load_skill', { id: 'conversation/feed-tuning' }));

/** Per turn: what the skill leg and a leg after a tool result say. `onSkill` sees the call. */
function script(opts: {
  skill: (call: GatewayCall) => string;
  after?: (call: GatewayCall) => ReturnType<GatewayResponder>;
}): GatewayResponder {
  return (call) => {
    if (call.route !== 'chat') return '';
    if (isRouteLeg(call)) return route;
    if (opts.after && (hasToolResult(call, 'proposeChanges') || hasToolResult(call, 'applyProposal'))) return opts.after(call);
    return opts.skill(call);
  };
}

const stage = script({
  skill: () => reply('Tap the card to hide it.', STAGE),
  after: () => 'Tap the card to hide it.',
});

describe('cards on the persona loop', () => {
  it('a staging turn puts the card on screen, and the next turn\'s yes applies it', async () => {
    let turn = 1;
    server.use(
      ...mockGateway((call) =>
        turn === 1
          ? stage(call)
          : script({
              skill: () => reply('Applying it.', toolCall('applyProposal')),
              after: () => 'Done, that filter is on.',
            })(call),
      ),
    );
    const { engine } = await attachCloud();
    engine.send('stop showing me celebrity gossip');
    await turnDone();

    const card = store().proposal;
    expect(card?.actions[0]).toMatchObject({ type: 'add_suppression', suppressionPattern: 'celebrity gossip' });
    expect(pendingProposalView()).toMatchObject({ id: card!.id, appliable: true, chooseOne: false });

    turn = 2;
    engine.send('yes');
    await turnDone();

    expect(store().resolvedProposals[card!.id]).toBe('applied');
    expect(store().proposal).toBeNull();
    // The loop was told a card waits, and that a typed yes may apply it.
    const skillLeg = gatewayCalls('chat').filter((c) => personMessage(c) === 'yes' && !isRouteLeg(c))[0];
    expect(systemOf(skillLeg)).toContain('<name>applyProposal</name>');
  });

  it('Stop on the staging turn clears that turn\'s card', async () => {
    // The claim beside the card earns a re-ask leg; Stop lands while that leg is open.
    server.use(
      ...mockGateway(
        script({
          skill: () => reply('Done, I have hidden it.', STAGE),
          after: () => ({ chunks: ['Tap'], stallAfter: 1 }),
        }),
      ),
    );
    const { engine } = await attachCloud();
    engine.send('stop showing me celebrity gossip');
    await until(() => store().proposal !== null, 15_000, 'card staged');

    stopChatTurn();
    await until(idle, 10_000, 'turn ends');

    expect(store().proposal).toBeNull();
    expect(Object.keys(store().resolvedProposals)).toEqual([]);
  });

  it('Stop on a later turn leaves an earlier turn\'s card alone', async () => {
    let turn = 1;
    server.use(
      ...mockGateway((call) =>
        turn === 1 ? stage(call) : { chunks: ['One moment '], stallAfter: 1 },
      ),
    );
    const { engine } = await attachCloud();
    engine.send('stop showing me celebrity gossip');
    await turnDone();
    const id = store().proposal!.id;

    turn = 2;
    engine.send('what is new today?');
    await until(() => gatewayCalls('chat').length > 2, 15_000, 'second turn started');
    stopChatTurn();
    await until(idle, 10_000, 'turn ends');

    expect(store().proposal?.id).toBe(id);
  });

  it('an apply that completed before Stop stays applied', async () => {
    let turn = 1;
    server.use(
      ...mockGateway((call) =>
        turn === 1
          ? stage(call)
          : script({
              skill: () => reply('Applying it.', toolCall('applyProposal')),
              after: () => ({ chunks: ['Done'], stallAfter: 1 }),
            })(call),
      ),
    );
    const { engine } = await attachCloud();
    engine.send('stop showing me celebrity gossip');
    await turnDone();
    const id = store().proposal!.id;

    turn = 2;
    engine.send('yes');
    await until(() => store().resolvedProposals[id] === 'applied', 15_000, 'applied');
    stopChatTurn();
    await until(idle, 10_000, 'turn ends');

    expect(store().resolvedProposals[id]).toBe('applied');
    expect(store().proposal).toBeNull();
  });

  it('a card holding a delete is not appliable from chat, and applyProposal is not offered', async () => {
    store().setProposal({
      id: 'p-del',
      explanation: 'Remove a fact.',
      expectedEffects: 'Gone.',
      actions: [{ type: 'delete_fact', fact_id: 'f1' }],
    } as never);
    expect(pendingProposalView()).toMatchObject({ id: 'p-del', summary: 'Remove a fact.', appliable: false, chooseOne: false });

    server.use(...mockGateway(script({ skill: () => 'Tap the card.', after: () => 'ok' })));
    const { engine } = await attachCloud();
    engine.send('yes');
    await turnDone();

    const skillLeg = gatewayCalls('chat').filter((c) => !isRouteLeg(c))[0];
    expect(skillLeg).toBeDefined();
    expect(systemOf(skillLeg)).not.toContain('<name>applyProposal</name>');
    expect(systemOf(skillLeg)).toContain('<name>cancelProposal</name>');
  });

  it('a settled card is no longer pending', () => {
    store().setProposal({ id: 'p-1', explanation: 'x', expectedEffects: 'y', actions: [{ type: 'run_calibration' }] } as never);
    expect(pendingProposalView()?.appliable).toBe(false);
    store().resolveProposal('cancelled');
    expect(pendingProposalView()).toBeNull();
  });
});
