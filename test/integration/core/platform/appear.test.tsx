// <Appear>: an object fades in when it mounts, fades out before it unmounts when `show` is given,
// rises only where movement is allowed, and keeps its children queryable the whole time.
import { act, render } from '@testing-library/react-native';
import React from 'react';
import { StyleSheet, Text } from 'react-native';
import { Appear, APPEAR } from '@/components/ui/appear';
import { useDisplayPrefsStore } from '@/lib/stores/display-prefs-store';

const styleOf = (node: { props: { style?: unknown } }) => StyleSheet.flatten(node.props.style as never) as { opacity?: number; transform?: { translateY: number }[] };

beforeEach(() => {
  jest.useFakeTimers();
  useDisplayPrefsStore.setState({ liteMode: false });
});
afterEach(() => jest.useRealTimers());

// jest's native animation mock never moves the value, so only the starting style is read here.
it('mounts transparent and lower', async () => {
  const view = await render(<Appear testID="box"><Text>hello</Text></Appear>);
  expect(view.getByText('hello')).toBeTruthy();
  expect(styleOf(view.getByTestId('box')).opacity).toBe(0);
  expect(styleOf(view.getByTestId('box')).transform?.[0].translateY).toBe(APPEAR.rise);

});

it('in Lite mode it fades and never moves', async () => {
  useDisplayPrefsStore.setState({ liteMode: true });
  const view = await render(<Appear testID="box"><Text>hello</Text></Appear>);
  expect(styleOf(view.getByTestId('box')).opacity).toBe(0);
  expect(styleOf(view.getByTestId('box')).transform).toBeUndefined();
});

it('with `show`, it stays mounted for the fade out, takes no touches, then unmounts', async () => {
  const view = await render(<Appear show testID="box"><Text>hello</Text></Appear>);
  await act(() => jest.advanceTimersByTime(APPEAR.in + 50));

  await view.rerender(<Appear show={false} testID="box"><Text>hello</Text></Appear>);
  expect(view.getByText('hello')).toBeTruthy();
  expect(view.getByTestId('box').props.pointerEvents).toBe('none');

  await act(() => jest.advanceTimersByTime(APPEAR.out + 50));
  expect(view.queryByText('hello')).toBeNull();
});

it('`show` false at mount renders nothing, and coming back mid-exit keeps it', async () => {
  const view = await render(<Appear show={false} testID="box"><Text>hello</Text></Appear>);
  expect(view.queryByText('hello')).toBeNull();

  await view.rerender(<Appear show testID="box"><Text>hello</Text></Appear>);
  await act(() => jest.advanceTimersByTime(APPEAR.in + 50));
  await view.rerender(<Appear show={false} testID="box"><Text>hello</Text></Appear>);
  await act(() => jest.advanceTimersByTime(APPEAR.out / 2));
  await view.rerender(<Appear show testID="box"><Text>hello</Text></Appear>);
  await act(() => jest.advanceTimersByTime(APPEAR.in + APPEAR.out));
  await view.rerender(<Appear show testID="box"><Text>hello</Text></Appear>);
  expect(view.getByText('hello')).toBeTruthy();
  expect(view.getByTestId('box').props.pointerEvents).not.toBe('none');
});

it('`animateOnMount` false draws the first mount at rest', async () => {
  const view = await render(<Appear animateOnMount={false} testID="box"><Text>hello</Text></Appear>);
  expect(styleOf(view.getByTestId('box')).opacity).toBe(1);
});
