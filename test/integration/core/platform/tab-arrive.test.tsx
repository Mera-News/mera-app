// <TabArrive>: the first tab at launch is drawn at rest, and a focus change never remounts the
// tab's content. jest finishes an Animated timing at once, so the fade itself is checked on a device.
import { render } from '@testing-library/react-native';
import React, { useEffect } from 'react';
import { StyleSheet, Text } from 'react-native';
import { resetTabArriveForTests, TabArrive } from '@/components/ui/appear/TabArrive';

let mockFocused = true;
jest.mock('expo-router', () => ({ useIsFocused: () => mockFocused }));

let mounts = 0;
function Page() {
  useEffect(() => {
    mounts += 1;
  }, []);
  return <Text>page</Text>;
}
const tab = (
  <TabArrive>
    <Page />
  </TabArrive>
);

beforeEach(() => {
  mockFocused = true;
  mounts = 0;
  resetTabArriveForTests();
});

it('draws the first tab of the launch at rest', async () => {
  const view = await render(tab);
  expect((StyleSheet.flatten(view.getByTestId('tab-arrive').props.style) as { opacity?: number }).opacity).toBe(1);
});

it('keeps the tab mounted through blur and focus', async () => {
  const view = await render(tab);
  for (const focused of [false, true, false, true]) {
    mockFocused = focused;
    await view.rerender(tab);
  }
  expect(view.getByText('page')).toBeTruthy();
  expect(mounts).toBe(1);
});
