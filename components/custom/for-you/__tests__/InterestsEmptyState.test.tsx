/* eslint-disable @typescript-eslint/no-require-imports */
import { fireEvent, render, screen } from '@testing-library/react-native';
import React from 'react';

jest.mock('react-i18next', () => ({ useTranslation: () => ({ t: (k: string) => k }) }));
const mockOpen = jest.fn();
jest.mock('@/components/custom/mera-button/open-mera-chat', () => ({
  openMeraChat: (...a: unknown[]) => mockOpen(...a),
}));
jest.mock('@/components/custom/mera-button/mera-pages', () => ({
  chatContextFor: (page: string) => ({ kind: 'persona', page }),
}));
jest.mock('@/components/ui/text', () => {
  const { Text } = require('react-native');
  return { Text: (p: any) => <Text {...p} /> };
});
jest.mock('@/components/ui/pressable', () => {
  const { Pressable } = require('react-native');
  return { Pressable };
});

import InterestsEmptyState from '../InterestsEmptyState';

describe('InterestsEmptyState', () => {
  it('says Mera knows no interests yet', () => {
    render(<InterestsEmptyState />);
    expect(screen.getByText('interests.emptyTitle')).toBeTruthy();
    expect(screen.getByText('interests.emptyBody')).toBeTruthy();
  });

  it('a starter opens the Interests chat with its text as a DRAFT, never sent', () => {
    render(<InterestsEmptyState />);
    fireEvent.press(screen.getByTestId('interests-starter-work'));
    expect(mockOpen).toHaveBeenCalledWith({ kind: 'persona', page: 'interests' }, { draft: 'interests.draftWork' });
  });

  it('every starter is a 44pt button labelled with its visible text', () => {
    render(<InterestsEmptyState />);
    for (const id of ['home', 'work', 'team']) {
      const b = screen.getByTestId(`interests-starter-${id}`);
      expect(b.props.style.minHeight).toBeGreaterThanOrEqual(44);
      expect(b.props.accessibilityLabel).toBe(`interests.chip${id[0].toUpperCase()}${id.slice(1)}`);
    }
  });
});
