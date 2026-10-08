import { act, fireEvent, render } from '@testing-library/react-native';
import React from 'react';
import { Keyboard } from 'react-native';

jest.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (k: string) => k }),
}));

import { PromptInput } from '../index';

type Handler = () => void;

function mockKeyboard() {
  const handlers: Record<string, Handler> = {};
  jest.spyOn(Keyboard, 'addListener').mockImplementation(((evt: string, cb: Handler) => {
    handlers[evt] = cb;
    return { remove: jest.fn() };
  }) as never);
  return handlers;
}

afterEach(() => jest.restoreAllMocks());

describe('PromptInput hide-keyboard button', () => {
  it('is absent until the keyboard is up, and gone again when it hides', () => {
    const handlers = mockKeyboard();
    const { queryByTestId } = render(<PromptInput onSubmit={() => {}} />);
    expect(queryByTestId('chat-hide-keyboard')).toBeNull();
    act(() => handlers.keyboardDidShow());
    expect(queryByTestId('chat-hide-keyboard')).not.toBeNull();
    act(() => handlers.keyboardDidHide());
    expect(queryByTestId('chat-hide-keyboard')).toBeNull();
  });

  it('dismisses the keyboard and carries the label', () => {
    const handlers = mockKeyboard();
    const dismiss = jest.spyOn(Keyboard, 'dismiss').mockImplementation(() => {});
    const { getByTestId } = render(<PromptInput onSubmit={() => {}} />);
    act(() => handlers.keyboardDidShow());
    const button = getByTestId('chat-hide-keyboard');
    expect(button.props.accessibilityLabel).toBe('chat.hideKeyboard');
    fireEvent.press(button);
    expect(dismiss).toHaveBeenCalledTimes(1);
  });

  it('send and hide share one box, so their centres line up with the field', () => {
    const handlers = mockKeyboard();
    const { getByTestId } = render(<PromptInput onSubmit={() => {}} />);
    act(() => handlers.keyboardDidShow());
    const box = (id: string) => {
      const parent = getByTestId(id).parent;
      return parent?.props.style;
    };
    expect(box('chat-hide-keyboard')).toEqual(box('chat-send'));
  });
});

describe('PromptInput send / stop', () => {
  it('idle: send, disabled while empty', () => {
    mockKeyboard();
    const { getByTestId, queryByTestId } = render(<PromptInput onSubmit={() => {}} onStop={() => {}} />);
    expect(queryByTestId('chat-stop')).toBeNull();
    expect(getByTestId('chat-send').props.accessibilityLabel).toBe('chat.send');
    expect(getByTestId('chat-send').props.accessibilityState).toEqual({ disabled: true });
  });

  it('busy: the same button is Stop, ENABLED even though the field is locked, and stops', () => {
    mockKeyboard();
    const onStop = jest.fn();
    const onSubmit = jest.fn();
    const { getByTestId, queryByTestId } = render(
      <PromptInput onSubmit={onSubmit} disabled busy onStop={onStop} />,
    );
    expect(queryByTestId('chat-send')).toBeNull();
    const stop = getByTestId('chat-stop');
    expect(stop.props.accessibilityLabel).toBe('chat.stop');
    expect(stop.props.accessibilityState).toEqual({ disabled: false });
    fireEvent.press(stop);
    expect(onStop).toHaveBeenCalledTimes(1);
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('toggles with busy and goes back to send when the turn ends', () => {
    mockKeyboard();
    const { getByTestId, rerender } = render(<PromptInput onSubmit={() => {}} busy onStop={() => {}} />);
    expect(getByTestId('chat-stop')).toBeTruthy();
    rerender(<PromptInput onSubmit={() => {}} busy={false} onStop={() => {}} />);
    expect(getByTestId('chat-send')).toBeTruthy();
  });
});
