// ux2 H: the chat header's bug button.

/* eslint-disable @typescript-eslint/no-require-imports */
import React from 'react';
import { fireEvent, render } from '@testing-library/react-native';

jest.mock('react-i18next', () => ({ useTranslation: () => ({ t: (k: string) => k }) }));
jest.mock('@expo/vector-icons', () => {
  const R = require('react');
  const RN = require('react-native');
  return { MaterialIcons: (p: any) => R.createElement(RN.View, { testID: `icon-${p.name}` }) };
});
jest.mock('@/components/ui/button', () => {
  const R = require('react');
  const RN = require('react-native');
  return { Button: (p: any) => R.createElement(RN.Pressable, p, p.children) };
});
jest.mock('@/lib/haptics', () => ({ hapticLight: jest.fn() }));
const mockOpen = jest.fn();
jest.mock('../chat-bug-report', () => ({
  openChatBugReport: (...a: unknown[]) => mockOpen(...a),
  currentChatTranscript: () => '09:05 You: hi',
}));

import ChatBugReportButton from '../ChatBugReportButton';

it('is labelled Report a bug and opens the report with the transcript and the disclosure', () => {
  const { getByLabelText, getByTestId } = render(<ChatBugReportButton />);
  expect(getByTestId('icon-bug-report')).toBeTruthy();
  fireEvent.press(getByLabelText('preferences.reportBug'));
  expect(mockOpen).toHaveBeenCalledWith('09:05 You: hi', 'feedback.chatAttachmentNote');
});
