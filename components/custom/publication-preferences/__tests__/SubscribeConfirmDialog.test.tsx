import { fireEvent, render } from '@testing-library/react-native';
import React from 'react';

jest.mock('react-native-css-interop/jsx-runtime', () => {
  return require('react/jsx-runtime');
});
jest.mock('react-native-css-interop/jsx-dev-runtime', () => {
  return require('react/jsx-dev-runtime');
});

jest.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (k: string, o?: Record<string, unknown>) => (o?.publisher ? `${k}:${o.publisher}` : k) }),
}));

jest.mock('@/components/ui/text', () => {
  const { Text } = require('react-native');
  return { Text };
});
jest.mock('@/components/ui/vstack', () => {
  const { View } = require('react-native');
  return { VStack: (p: any) => <View {...p} /> };
});
jest.mock('@/components/ui/button', () => {
  const { Pressable, Text } = require('react-native');
  return {
    Button: (p: any) => <Pressable {...p} />,
    ButtonText: (p: any) => <Text {...p} />,
  };
});

// `onClose` is the whole subject of this file, so the mock EXPOSES it as a
// real pressable rather than spreading it onto a View where nothing can reach
// it. A modal mock that swallows onClose cannot tell a dismiss from a No,
// which is exactly the bug under test.
jest.mock('@/components/ui/modal', () => {
  const { View, Pressable } = require('react-native');
  const Pass = ({ children, ...rest }: any) => <View {...rest}>{children}</View>;
  return {
    Modal: ({ isOpen, onClose, children }: any) =>
      isOpen ? (
        <View>
          <Pressable testID="modal-dismiss" onPress={onClose} />
          {children}
        </View>
      ) : null,
    ModalBackdrop: () => null,
    ModalContent: Pass,
    ModalHeader: Pass,
    ModalBody: Pass,
    ModalFooter: Pass,
  };
});

import SubscribeConfirmDialog from '../SubscribeConfirmDialog';

/**
 * `accessibilityViewIsModal` on ModalContent marks every SIBLING as hidden
 * from the accessibility tree, and RNTL's default queries cannot see hidden
 * elements. The dismiss control is such a sibling, so without this option the
 * query fails while the node is plainly in the rendered tree - an absence
 * assertion here would pass for entirely the wrong reason.
 */
const dismissControl = (utils: { getByTestId: any }) =>
  utils.getByTestId('modal-dismiss', { includeHiddenElements: true });

const setup = () => {
  const onYes = jest.fn();
  const onNo = jest.fn();
  const onDismiss = jest.fn();
  const utils = render(
    <SubscribeConfirmDialog
      publisherName="Het Parool"
      onYes={onYes}
      onNo={onNo}
      onDismiss={onDismiss}
    />,
  );
  return { ...utils, onYes, onNo, onDismiss };
};

describe('SubscribeConfirmDialog — a dismissal is not a decision', () => {
  it('renders nothing without a publisher name', () => {
    const { queryByTestId } = render(
      <SubscribeConfirmDialog
        publisherName={null}
        onYes={jest.fn()}
        onNo={jest.fn()}
        onDismiss={jest.fn()}
      />,
    );
    expect(queryByTestId('modal-dismiss', { includeHiddenElements: true })).toBeNull();
  });

  it('a swipe-down or hardware back DISMISSES and never declines', () => {
    // The regression this guards: onClose used to be wired straight to onNo,
    // so dismissing the sheet permanently silenced the prompt for a publisher
    // the reader had not answered about.
    const utils = setup();
    const { onNo, onYes, onDismiss } = utils;

    fireEvent.press(dismissControl(utils));

    expect(onDismiss).toHaveBeenCalledTimes(1);
    expect(onNo).not.toHaveBeenCalled();
    expect(onYes).not.toHaveBeenCalled();
  });

  it('the No button DECLINES and never merely dismisses', () => {
    const { getByText, onNo, onDismiss } = setup();

    fireEvent.press(getByText('subscriptions.confirmNo'));

    expect(onNo).toHaveBeenCalledTimes(1);
    expect(onDismiss).not.toHaveBeenCalled();
  });

  it('the Yes button confirms', () => {
    const { getByText, onYes, onNo, onDismiss } = setup();

    fireEvent.press(getByText('subscriptions.confirmYes'));

    expect(onYes).toHaveBeenCalledTimes(1);
    expect(onNo).not.toHaveBeenCalled();
    expect(onDismiss).not.toHaveBeenCalled();
  });

  it('names the publisher in the title, so a screen reader says which one', () => {
    const { getAllByText } = setup();
    expect(getAllByText('subscriptions.confirmTitle:Het Parool').length).toBeGreaterThan(0);
  });
});
