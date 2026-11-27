// Dim: a chat card that mounts already settled is drawn dimmed at once (a reopened thread never
// fades), and a live card is drawn at full opacity. jest's native animation mock never moves the
// value, so only the starting style is read.
import { render } from '@testing-library/react-native';
import React from 'react';
import { StyleSheet, Text } from 'react-native';
import { Dim } from '@/components/custom/floating-chat/Dim';

const opacityOf = (node: { parent: { props: { style?: unknown } } | null }) =>
  (StyleSheet.flatten(node.parent?.props.style as never) as { opacity?: number }).opacity;

it('mounts dimmed when the card is already settled', async () => {
  const view = await render(<Dim on to={0.5}><Text testID="card">card</Text></Dim>);
  expect(opacityOf(view.getByTestId('card'))).toBe(0.5);
});

it('mounts at full opacity while the card is live', async () => {
  const view = await render(<Dim on={false} to={0.5}><Text testID="card">card</Text></Dim>);
  expect(opacityOf(view.getByTestId('card'))).toBe(1);
});
