/* eslint-disable @typescript-eslint/no-require-imports */
// N4: the "?" explainer. The copy tests read the DICTIONARIES directly: the
// global t() mock would make any key "exist".
import fs from 'fs';
import path from 'path';

jest.mock('react-i18next', () => ({ useTranslation: () => ({ t: (k: string) => k }) }));
let mockFocused = true;
jest.mock('@/lib/hooks/use-is-focused-safe', () => ({ useIsFocusedSafe: () => mockFocused }));
jest.mock('@/components/ui/modal', () => {
  const { View } = require('react-native');
  const Pass = ({ children, testID }: any) => <View testID={testID}>{children}</View>;
  return {
    Modal: ({ children, isOpen }: any) => (isOpen ? <View>{children}</View> : null),
    ModalBackdrop: () => null,
    ModalBody: Pass,
    ModalContent: Pass,
    ModalFooter: Pass,
    ModalHeader: Pass,
  };
});
jest.mock('@/components/ui/button', () => {
  const { Pressable, Text } = require('react-native');
  return { Button: (p: any) => <Pressable {...p} />, ButtonText: (p: any) => <Text {...p} /> };
});
jest.mock('@/components/ui/heading', () => {
  const { Text } = require('react-native');
  return { Heading: (p: any) => <Text {...p} /> };
});
jest.mock('@/components/ui/text', () => {
  const { Text } = require('react-native');
  return { Text: (p: any) => <Text {...p} /> };
});
jest.mock('@/components/ui/vstack', () => {
  const { View } = require('react-native');
  return { VStack: (p: any) => <View {...p} /> };
});
jest.mock('@/components/ui/pressable', () => {
  const { Pressable } = require('react-native');
  return { Pressable };
});
jest.mock('@expo/vector-icons', () => {
  const { View } = require('react-native');
  return { MaterialIcons: (p: any) => <View {...p} /> };
});

import { fireEvent, render, screen } from '@testing-library/react-native';
import React from 'react';
import TabExplainerButton from '../TabExplainerButton';
import { TAB_EXPLAINER_PARAGRAPHS, TAB_EXPLAINER_TITLES } from '../TabExplainerSheet';

const LOCALES_DIR = path.resolve(__dirname, '../../../../lib/locales');
const LOCALES = fs.readdirSync(LOCALES_DIR).filter((f) => /^[a-zA-Z-]+\.json$/.test(f));
const get = (dict: any, key: string) => key.split('.').reduce((o, k) => o?.[k], dict);

describe('TabExplainerButton', () => {
  it('opens the sheet for its tab and closes it again', () => {
    render(<TabExplainerButton tab="forYou" testID="dashboard-explainer-open" />);
    expect(screen.queryByTestId('tab-explainer-forYou')).toBeNull();
    fireEvent.press(screen.getByTestId('dashboard-explainer-open'));
    expect(screen.getByTestId('tab-explainer-forYou')).toBeTruthy();
    expect(screen.getByText('tabExplainer.forYou.how1')).toBeTruthy();
    fireEvent.press(screen.getByTestId('tab-explainer-forYou-close'));
    expect(screen.queryByTestId('tab-explainer-forYou')).toBeNull();
  });

  it('closes when its tab loses focus, so it is not waiting on return', () => {
    // The sheet lives inside the tab's screen, not above the tab bar: left
    // open, it reappeared "by itself" when the reader came back to the tab.
    mockFocused = true;
    const view = render(<TabExplainerButton tab="explore" testID="explore-explainer-open" />);
    fireEvent.press(screen.getByTestId('explore-explainer-open'));
    expect(screen.getByTestId('tab-explainer-explore')).toBeTruthy();
    mockFocused = false;
    view.rerender(<TabExplainerButton tab="explore" testID="explore-explainer-open" />);
    mockFocused = true;
    view.rerender(<TabExplainerButton tab="explore" testID="explore-explainer-open" />);
    expect(screen.queryByTestId('tab-explainer-explore')).toBeNull();
  });

  it('is a labelled button with a 44pt target', () => {
    render(<TabExplainerButton tab="feed" testID="feed-explainer-open" />);
    const button = screen.getByTestId('feed-explainer-open');
    expect(button.props.accessibilityLabel).toBe('tabExplainer.openA11y');
    expect(button.props.hitSlop).toBe(10);
  });
});

describe('the explainer copy', () => {
  const keys = [
    'tabExplainer.openA11y',
    'tabExplainer.close',
    ...Object.values(TAB_EXPLAINER_TITLES),
    ...Object.values(TAB_EXPLAINER_PARAGRAPHS).flat(),
  ];

  it('finds twenty dictionaries', () => {
    expect(LOCALES).toHaveLength(20);
  });

  it('has every key as a non-empty string in every locale', () => {
    const missing: string[] = [];
    for (const file of LOCALES) {
      const dict = JSON.parse(fs.readFileSync(path.join(LOCALES_DIR, file), 'utf8'));
      for (const key of keys) {
        const v = get(dict, key);
        if (typeof v !== 'string' || v.trim() === '') missing.push(`${file} ${key}`);
      }
    }
    expect(missing).toEqual([]);
  });

  it('uses no em or en dash in any locale', () => {
    const bad: string[] = [];
    for (const file of LOCALES) {
      const dict = JSON.parse(fs.readFileSync(path.join(LOCALES_DIR, file), 'utf8'));
      for (const key of keys) {
        const v = get(dict, key);
        if (typeof v === 'string' && /[—–]/.test(v)) bad.push(`${file} ${key}`);
      }
    }
    expect(bad).toEqual([]);
  });

  it('never calls the product open source', () => {
    const en = JSON.parse(fs.readFileSync(path.join(LOCALES_DIR, 'en.json'), 'utf8'));
    for (const key of keys) expect(String(get(en, key))).not.toMatch(/open source/i);
  });
});
