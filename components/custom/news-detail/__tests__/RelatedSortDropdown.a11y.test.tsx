// RelatedSortDropdown: the sort menu must be reachable by VoiceOver (ux2).
// Gluestack's Menu is an anchored popover, portalled to the app root outside
// the native screen, where VoiceOver cannot reach its items.
/* eslint-disable @typescript-eslint/no-require-imports */
jest.mock('react-i18next', () => ({
    useTranslation: () => ({ t: (k: string) => k }),
}));
jest.mock('@/components/ui/text', () => {
    const { Text } = require('react-native');
    return { Text };
});
jest.mock('@/components/ui/pressable', () => {
    const { Pressable } = require('react-native');
    return { Pressable };
});
jest.mock('@/components/ui/icon', () => ({ CheckIcon: 'Check', ChevronDownIcon: 'Chevron', Icon: () => null }));
jest.mock('@expo/vector-icons', () => ({ MaterialIcons: () => null }));
jest.mock('@/lib/stores/related-sort-store', () => ({ RELATED_SORT_MODES: ['relevance', 'oldest', 'newest'] }));
jest.mock('@/components/ui/menu', () => {
    const { View, Pressable, Text } = require('react-native');
    return {
        // As gluestack: the trigger gets an onPress that opens; controlled via
        // isOpen/onOpen/onClose; the rest of the props reach the menu content.
        Menu: ({ isOpen, onOpen, onClose, trigger, children, useRNModal, placement, offset, closeOnSelect, ...rest }: any) => (
            <View testID="menu" {...{ useRNModal }}>
                {trigger({ onPress: onOpen })}
                {isOpen ? (
                    <View testID="menu-content" {...rest}>
                        {children}
                    </View>
                ) : null}
            </View>
        ),
        MenuItem: ({ onPress, children, testID }: any) => (
            <Pressable testID={testID} onPress={onPress}>
                {children}
            </Pressable>
        ),
        MenuItemLabel: ({ children }: any) => <Text>{children}</Text>,
    };
});

import { fireEvent, render } from '@testing-library/react-native';
import React from 'react';
import RelatedSortDropdown from '../RelatedSortDropdown';

it('presents in a native modal', () => {
    const r = render(<RelatedSortDropdown value="relevance" onChange={jest.fn()} testIDPrefix="rs" />);
    expect(r.getByTestId('menu').props.useRNModal).toBe(true);
});

it('opens, picks, and the VoiceOver escape gesture closes it', () => {
    const onChange = jest.fn();
    const r = render(<RelatedSortDropdown value="relevance" onChange={onChange} testIDPrefix="rs" />);
    fireEvent.press(r.getByTestId('rs-trigger'));
    expect(r.getByTestId('menu-content')).toBeTruthy();
    fireEvent(r.getByTestId('menu-content'), 'accessibilityEscape');
    expect(r.queryByTestId('menu-content')).toBeNull();
    fireEvent.press(r.getByTestId('rs-trigger'));
    fireEvent.press(r.getByTestId('rs-oldest'));
    expect(onChange).toHaveBeenCalledWith('oldest');
});
