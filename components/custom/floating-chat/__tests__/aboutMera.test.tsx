import { fireEvent, render } from '@testing-library/react-native';
import fs from 'fs';
import path from 'path';
import React from 'react';

import en from '@/lib/locales/en.json';

const mockOpenInAppBrowser = jest.fn(() => Promise.resolve());
let mockOnClosed: (() => void) | undefined;

jest.mock('react-i18next', () => {
  const dict = require('@/lib/locales/en.json');
  const get = (k: string) => k.split('.').reduce((n: any, p: string) => n?.[p], dict) ?? k;
  return { useTranslation: () => ({ t: get }) };
});
jest.mock('@/lib/web-browser-utils', () => ({
  openInAppBrowser: (u: string) => mockOpenInAppBrowser(u),
  withAppLanguage: (u: string) => u,
}));
jest.mock('@/lib/theme/tokens', () => ({
  useColors: () => ({ ink: '#000', ink2: '#555', accentText: '#c60' }),
}));
jest.mock('@/components/ui/help-modal', () => {
  const { View } = require('react-native');
  return {
    HelpModal: ({ open, children, title, onClosed }: any) => {
      mockOnClosed = onClosed;
      return open ? (
        <View testID="help" accessibilityLabel={title}>
          {children}
        </View>
      ) : null;
    },
  };
});

import AboutMeraModal from '../AboutMeraModal';

const read = (f: string) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');

describe('About Mera', () => {
  it('shows the Art. 50 sentence, the link and the mistakes line', () => {
    const { getByTestId, getByText } = render(<AboutMeraModal open onClose={() => {}} />);
    expect(getByTestId('help').props.accessibilityLabel).toBe(en.floatingChat.aboutTitle);
    expect(getByTestId('chat-guidelines')).toBeTruthy();
    expect(getByText(en.floatingChat.mayMistakes)).toBeTruthy();
  });

  it('the policy link closes the card, then opens the policy once it is gone', () => {
    const onClose = jest.fn();
    const { getByTestId } = render(<AboutMeraModal open onClose={onClose} />);
    fireEvent.press(getByTestId('chat-guidelines-link'));
    expect(onClose).toHaveBeenCalled();
    expect(mockOpenInAppBrowser).not.toHaveBeenCalled();
    mockOnClosed?.();
    expect(mockOpenInAppBrowser).toHaveBeenCalledTimes(1);
  });
});

describe('the disclosure lives in the header, not the thread', () => {
  it('ChatThread no longer draws the banner', () => {
    const src = read('ChatThread.tsx');
    expect(src).not.toContain('chat-guidelines');
    expect(src).not.toContain('guidelinesBefore');
  });

  it('the header shows the subtitle and opens About Mera from the title block', () => {
    const src = read('ChatPopover.tsx');
    expect(src).toContain('floatingChat.aiSubtitle');
    expect(src).toContain('AboutMeraModal');
    expect(src).toContain('markHelpOrigin');
    // tap and swipe-down share one detector
    expect(src).toMatch(/Gesture\.Race\(\s*swipeDownGesture/);
  });
});
