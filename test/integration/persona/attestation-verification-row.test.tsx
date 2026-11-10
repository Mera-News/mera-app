// Verify attestation over the profiles in use. The router state is scripted (the router has its
// own suite); the attestation fetch is the edge, so it is spied. Verify is the only place the app
// names a provider: a link in each model's result line.
import React from 'react';
import { Linking } from 'react-native';
import { act, fireEvent, render } from '@testing-library/react-native';
import { AttestationVerificationRow } from '@/components/custom/config-mera/AttestationVerificationRow';
import * as e2eeService from '@/lib/e2ee/e2ee-service';
import { initI18nEn } from '@/test/helpers';
import type { RoutingState } from '@/lib/llm/router';

let mockState: RoutingState;
jest.mock('@/lib/llm/router', () => ({
  ...jest.requireActual('@/lib/llm/router'),
  useRoutingState: () => mockState,
}));

const lane = (active: RoutingState['lanes']['topics']['active'], state: 'ok' | 'degraded' | 'down' = 'ok') => ({ state, active });
const big = { id: 'near/qwen3.8-27b', provider: 'near' } as const;
const small = { id: 'near/qwen3.6-35b-a3b', provider: 'near' } as const;
const red = { id: 'redpill/qwen3.8-27b', provider: 'redpill' } as const;

beforeAll(initI18nEn);
beforeEach(() => {
  mockState = {
    version: 1,
    lanes: {
      'chat-tools': lane(big),
      'chat-single': lane(big),
      scoring: lane(small),
      topics: lane(small),
      background: lane(small),
    },
  };
});
afterEach(() => jest.restoreAllMocks());

async function runVerify() {
  const view = await render(<AttestationVerificationRow />);
  await fireEvent.press(view.getByTestId('mera-protocol-attestation-toggle'));
  await act(async () => {
    fireEvent.press(view.getByTestId('mera-protocol-attestation-run'));
  });
  return view;
}

describe('AttestationVerificationRow over active profiles', () => {
  it('fetches one attestation per provider and model in use, with the provider', async () => {
    mockState.lanes['chat-tools'] = lane(red, 'degraded');
    const fetchSpy = jest
      .spyOn(e2eeService, 'fetchAttestationForVerification')
      .mockRejectedValue(new Error('offline'));
    await runVerify();
    const calls = fetchSpy.mock.calls.map(([model, , provider]) => `${provider}:${model}`).sort();
    expect(calls).toEqual([
      'near:Qwen/Qwen3.6-35B-A3B-FP8',
      'near:Qwen/Qwen3.8-27B',
      'redpill:qwen/qwen3.8-27b',
    ]);
  });

  it('names each result by a provider link and its model, and the link opens the provider site', async () => {
    mockState.lanes['chat-tools'] = lane(red, 'degraded');
    jest.spyOn(e2eeService, 'fetchAttestationForVerification').mockResolvedValue({
      attestation: { intel_quote: '', signing_public_key: '' },
    } as never);
    jest.spyOn(e2eeService, 'fetchComposeFile').mockRejectedValue(new Error('offline'));
    const open = jest.spyOn(Linking, 'openURL').mockResolvedValue(undefined as never);

    const view = await runVerify();

    expect(view.getByTestId('attestation-model-qwen/qwen3.8-27b')).toHaveTextContent('RedPill · qwen/qwen3.8-27b', { exact: false });
    expect(view.getByTestId('attestation-model-Qwen/Qwen3.6-35B-A3B-FP8')).toHaveTextContent('NEAR AI · Qwen/Qwen3.6-35B-A3B-FP8', { exact: false });
    fireEvent.press(view.getByLabelText('Open RedPill website'));
    expect(open).toHaveBeenCalledWith('https://redpill.ai');
  });
});
