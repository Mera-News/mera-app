// The `transient` bubble variant.
//
// A wait line is not part of the conversation: it is replaced by the reply
// rather than kept above it, and it has to look like that before the reply
// arrives. Asserted on the rendered style rather than by snapshot, so a
// reviewer reading a failure sees which property moved.

/* eslint-disable @typescript-eslint/no-require-imports */

// `chat-ai` pulls ActivityIndicator, whose RN mock `requireActual`s an
// untransformed specs_DEPRECATED file and kills the suite at load. Same mock
// `floating-chat/__tests__/chatThreadComposerGate.test.tsx` already carries,
// for the same reason.
jest.mock('react-native/Libraries/Components/ActivityIndicator/ActivityIndicator', () => {
  const R = require('react');
  const RN = require('react-native');
  return { __esModule: true, default: (p: any) => R.createElement(RN.View, p) };
});

import { render } from '@testing-library/react-native';
import React from 'react';
import { StyleSheet } from 'react-native';
import { MessageContent } from '../chat-ai';
import { Text } from 'react-native';

function bubbleStyle(variant?: 'solid' | 'transient') {
  const r = render(
    <MessageContent role="assistant" variant={variant} testID="bubble">
      <Text>hi</Text>
    </MessageContent>,
  );
  return StyleSheet.flatten(r.getByTestId('bubble').props.style) as Record<string, unknown>;
}

describe('MessageContent variant', () => {
  it('defaults to a filled, floating bubble', () => {
    const s = bubbleStyle();
    expect(s.backgroundColor).toBe('#232323');
    expect(s.borderWidth).toBeUndefined();
    expect(s.shadowOpacity).toBe(0.4);
  });

  it('renders `transient` as outlined, unfilled and FLAT', () => {
    const s = bubbleStyle('transient');
    expect(s.backgroundColor).toBe('transparent');
    expect(s.borderWidth).toBe(1);
    // The flatness is the load-bearing half. A solid bubble floats off the
    // panel and reads as something that was said; a provisional one must not.
    expect(s.shadowOpacity).toBe(0);
    expect(s.elevation).toBe(0);
  });

  it('keeps the border NEUTRAL, never the accent', () => {
    // The panel keeps the only orange outline in the chat, as
    // `bubbleAssistant` records. A second one competes with it.
    const s = bubbleStyle('transient');
    expect(String(s.borderColor)).not.toMatch(/231|138|83/);
  });

  it('keeps the shared geometry, so the two variants line up', () => {
    const solid = bubbleStyle();
    const transient = bubbleStyle('transient');
    expect(transient.borderRadius).toBe(solid.borderRadius);
    expect(transient.paddingHorizontal).toBe(solid.paddingHorizontal);
    expect(transient.maxWidth).toBe(solid.maxWidth);
  });
});
