// Private cloud tab provider card and Verify over the profiles in use. The router state is scripted
// (the router has its own suite); the attestation fetch is the edge, so it is spied.
import React from 'react';
import { Linking } from 'react-native';
import { act, fireEvent, render } from '@testing-library/react-native';
import { ProviderCard } from '@/components/custom/config-mera/ProviderCard';
import { AttestationVerificationRow } from '@/components/custom/config-mera/AttestationVerificationRow';
import * as e2eeService from '@/lib/e2ee/e2ee-service';
import { initI18nEn } from '@/test/helpers';
import type { RoutingState } from '@/lib/llm/router';

let mockState: RoutingState;
jest.mock('@/lib/llm/router', () => ({
  ...jest.requireActual('@/lib/llm/router'),
  useRoutingState: () => mockState,
}));

const NEAR = { provider: 'near', providerName: 'NEAR AI', providerUrl: 'https://near.ai' } as const;
const RED = { provider: 'redpill', providerName: 'RedPill', providerUrl: 'https://redpill.ai' } as const;
const lane = (active: RoutingState['lanes']['topics']['active'], state: 'ok' | 'degraded' | 'down' = 'ok') => ({ state, active });
const big = { id: 'near/qwen3.8-27b', ...NEAR, modelLabel: 'Qwen3.8 27B' };
const small = { id: 'near/qwen3.6-35b-a3b', ...NEAR, modelLabel: 'Qwen3.6 35B' };
const red = { id: 'redpill/qwen3.8-27b', ...RED, modelLabel: 'Qwen3.8 27B' };

beforeAll(initI18nEn);
beforeEach(() => {
  mockState = {
    version: 1,
    lanes: {
      'chat-tools': lane(big),
      'chat-single': lane(big),
      'fact-check': lane(big),
      scoring: lane(small),
      topics: lane(small),
      background: lane(small),
    },
  };
});
afterEach(() => jest.restoreAllMocks());

/** The card opens minimised; most tests read the open card. */
async function renderOpen() {
  const view = await render(<ProviderCard />);
  await fireEvent.press(view.getByTestId('provider-card-toggle'));
  return view;
}

describe('ProviderCard', () => {
  it('opens minimised: one Provider row naming the provider, no links or models until tapped', async () => {
    const view = await render(<ProviderCard />);
    expect(view.getByTestId('provider-card-toggle')).toHaveTextContent('NEAR AI', { exact: false });
    expect(view.queryByLabelText('Open NEAR AI website')).toBeNull();
    expect(view.queryByTestId('provider-lane-chat-tools')).toBeNull();
    await fireEvent.press(view.getByTestId('provider-card-toggle'));
    expect(view.getByLabelText('Open NEAR AI website')).toBeTruthy();
    expect(view.getByTestId('provider-lane-chat-tools')).toBeTruthy();
  });

  it('shows NEAR AI as the provider and each lane with its model', async () => {
    const view = await renderOpen();
    expect(view.getByLabelText('Open NEAR AI website')).toBeTruthy();
    expect(view.queryByText('RedPill')).toBeNull();
    expect(view.getByText('Chat')).toBeTruthy();
    expect(view.getByText('Feed picks')).toBeTruthy();
    expect(view.getAllByText('Qwen3.6 35B')).toHaveLength(3);
  });

  it('marks RedPill as the backup while a lane fails over to it', async () => {
    mockState.lanes['chat-tools'] = lane(red, 'degraded');
    const view = await renderOpen();
    expect(view.getByTestId('provider-card-toggle')).toHaveTextContent(/NEAR AI/);
    expect(view.getByTestId('provider-card-toggle')).toHaveTextContent(/RedPill/);
    expect(view.getByLabelText('Open RedPill website')).toBeTruthy();
    expect(view.getByText('(backup)')).toBeTruthy();
  });

  it('shows Paused for a lane that is down', async () => {
    mockState.lanes.scoring = lane(null, 'down');
    const view = await renderOpen();
    expect(view.getByTestId('provider-lane-scoring')).toHaveTextContent('Paused', { exact: false });
    expect(view.getByTestId('provider-lane-topics')).toHaveTextContent('Qwen3.6 35B', { exact: false });
  });

  it('opens the provider site', async () => {
    const open = jest.spyOn(Linking, 'openURL').mockResolvedValue(undefined as never);
    const view = await renderOpen();
    fireEvent.press(view.getByLabelText('Open NEAR AI website'));
    expect(open).toHaveBeenCalledWith('https://near.ai');
  });
});

describe('AttestationVerificationRow over active profiles', () => {
  it('fetches one attestation per provider and model in use, with the provider', async () => {
    mockState.lanes['chat-tools'] = lane(red, 'degraded');
    const fetchSpy = jest
      .spyOn(e2eeService, 'fetchAttestationForVerification')
      .mockRejectedValue(new Error('offline'));
    const view = await render(<AttestationVerificationRow />);
    await fireEvent.press(view.getByTestId('mera-protocol-attestation-toggle'));
    await act(async () => {
      fireEvent.press(view.getByTestId('mera-protocol-attestation-run'));
    });
    const calls = fetchSpy.mock.calls.map(([model, , provider]) => `${provider}:${model}`).sort();
    expect(calls).toEqual([
      'near:Qwen/Qwen3.6-35B-A3B-FP8',
      'near:Qwen/Qwen3.8-27B',
      'redpill:qwen/qwen3.8-27b',
    ]);
  });
});
