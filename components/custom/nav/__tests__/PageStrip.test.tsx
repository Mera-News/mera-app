/* eslint-disable @typescript-eslint/no-require-imports */
jest.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (k: string, o?: Record<string, unknown>) => (o ? `${k}|${JSON.stringify(o)}` : k),
  }),
}));
jest.mock('@/components/custom/GlassSurface', () => ({ GlassPanel: ({ children }: any) => children }));
jest.mock('@/components/custom/notifications/NotificationBellButton', () => {
  const { View } = require('react-native');
  return { __esModule: true, default: () => <View testID="bell" /> };
});
const mockNavigateToSetting = jest.fn();
jest.mock('@/lib/navigation/focus-target', () => ({
  navigateToSetting: (...a: unknown[]) => mockNavigateToSetting(...a),
}));
jest.mock('@/components/ui/text', () => {
  const { Text } = require('react-native');
  return { Text: (p: any) => <Text {...p} /> };
});
jest.mock('@/components/ui/pressable', () => {
  const { Pressable } = require('react-native');
  return { Pressable };
});
// jest-expo mis-transforms RN's horizontal ScrollView native component
// ("Unexpected token 'export'"): proxy RN so ScrollView is a plain View.
const mockScrollTo = jest.fn();
jest.mock('react-native', () => {
  const actual = jest.requireActual('react-native');
  const ReactLib = require('react');
  const StubScrollView: any = ReactLib.forwardRef(({ children, ...rest }: any, ref: any) => {
    ReactLib.useImperativeHandle(ref, () => ({ scrollTo: (a: any) => mockScrollTo(a) }));
    return ReactLib.createElement(actual.View, rest, children);
  });
  StubScrollView.Context = ReactLib.createContext(null);
  return new Proxy(actual, {
    get(target, prop) {
      if (prop === 'ScrollView') return StubScrollView;
      return (target as any)[prop];
    },
  });
});
jest.mock('@expo/vector-icons', () => require('@/lib/__test-helpers__/icon-glyph-a11y').glyphIconModule());

import { configure, fireEvent, render, screen } from '@testing-library/react-native';
import React from 'react';
import PageStrip, { flagEmoji, pillA11yRoles } from '../PageStrip';
import type { PagePill } from '../types';

configure({ defaultIncludeHiddenElements: true });

const pages: PagePill[] = [
  { id: 'feed', label: 'Feed' },
  { id: 'interests', label: 'Interests' },
  { id: 'stories', label: 'Stories', useDot: () => ({ visible: true }) },
];

function renderStrip(over: Partial<React.ComponentProps<typeof PageStrip>> = {}) {
  const onSelect = jest.fn();
  const onRearrange = jest.fn();
  render(
    <PageStrip
      tabLabel="Feed"
      pages={pages}
      activeId="interests"
      onSelect={onSelect}
      onRearrange={onRearrange}
      quickSettings={['profile.facts', 'profile.places']}
      trailing="bell"
      {...over}
    />,
  );
  return { onSelect, onRearrange };
}

describe('PageStrip', () => {
  it('labels each pill with its position, and the dot in the label', () => {
    renderStrip();
    expect(screen.getByTestId('page-pill-feed').props.accessibilityLabel).toBe(
      'nav.pillA11y|{"label":"Feed","index":1,"count":3}',
    );
    expect(screen.getByTestId('page-pill-stories').props.accessibilityLabel).toBe(
      'nav.pillNewA11y|{"label":"Stories","index":3,"count":3}',
    );
    expect(screen.getByTestId('page-pill-stories-dot')).toBeTruthy();
    expect(screen.queryByTestId('page-pill-feed-dot')).toBeNull();
  });

  it('marks only the active pill selected and selects on press', () => {
    const { onSelect } = renderStrip();
    expect(screen.getByTestId('page-pill-interests').props.accessibilityState).toEqual({ selected: true });
    expect(screen.getByTestId('page-pill-feed').props.accessibilityState).toEqual({ selected: false });
    fireEvent.press(screen.getByTestId('page-pill-stories'));
    expect(onSelect).toHaveBeenCalledWith('stories');
  });

  it('pen names the tab and opens Arrange', () => {
    const { onRearrange } = renderStrip();
    const pen = screen.getByTestId('page-strip-rearrange');
    expect(pen.props.accessibilityLabel).toBe('nav.rearrangeA11y|{"tab":"Feed"}');
    fireEvent.press(pen);
    expect(onRearrange).toHaveBeenCalled();
  });

  it('quick settings jump to the page targets, named for the active page', () => {
    renderStrip();
    const qs = screen.getByTestId('quick-settings');
    expect(qs.props.accessibilityLabel).toBe('nav.quickSettingsA11y|{"page":"Interests"}');
    fireEvent.press(qs);
    expect(mockNavigateToSetting).toHaveBeenCalledWith(['profile.facts', 'profile.places']);
  });

  it('draws no quick settings where the page has none, and search instead of the bell', () => {
    const onPress = jest.fn();
    renderStrip({ quickSettings: null, trailing: { kind: 'search', onPress } });
    expect(screen.queryByTestId('quick-settings')).toBeNull();
    expect(screen.queryByTestId('bell')).toBeNull();
    fireEvent.press(screen.getByTestId('page-strip-search'));
    expect(onPress).toHaveBeenCalled();
  });

  it('gives every control a 44pt frame', () => {
    renderStrip();
    expect(screen.getByTestId('page-strip-rearrange-frame').props.style.height).toBe(44);
    expect(screen.getByTestId('quick-settings-frame').props.style.height).toBe(44);
    const frame = screen.getByTestId('page-pill-feed-frame');
    expect(frame.props.style.paddingVertical * 2 + 34).toBe(44);
  });

  it('draws the pen and the quick-settings glyph and badge white; only the active pill is orange', () => {
    const { HEADER_ICON_COLOR } = require('@/components/custom/for-you/HeaderIconButton');
    renderStrip();
    expect(screen.getByTestId('page-strip-rearrange-glyph').props.color).toBe(HEADER_ICON_COLOR);
    expect(screen.getByTestId('icon-tune').props.color).toBe(HEADER_ICON_COLOR);
    const badge = screen.getByTestId('quick-settings-bolt');
    const flat = Object.assign({}, ...[badge.props.style].flat());
    expect(flat.backgroundColor).toBe(HEADER_ICON_COLOR);
    // The bolt and the ring keep the header ink.
    expect(screen.getByTestId('icon-bolt').props.color).toBe('#121113');
    expect(flat.borderColor).toBe('#121113');
    const active = Object.assign({}, ...[screen.getByTestId('page-pill-interests-chip').props.style].flat());
    expect(active.backgroundColor).toBe('#E78A53');
  });

  it('leaks no icon glyph into a label', () => {
    renderStrip();
    const { privateUseLabelLeaks } = require('@/lib/__test-helpers__/icon-glyph-a11y');
    expect(privateUseLabelLeaks(screen.root)).toEqual([]);
  });
});

describe('pill helpers', () => {
  it('builds a flag from alpha-2, Kosovo included', () => {
    expect(flagEmoji('de')).toBe('🇩🇪');
    expect(flagEmoji('XK')).toBe('🇽🇰');
    expect(flagEmoji('DEU')).toBe('');
  });

  it('uses button-in-tabbar on iOS and tabs on Android', () => {
    expect(pillA11yRoles('ios')).toEqual({ row: 'tabbar', pill: 'button' });
    expect(pillA11yRoles('android')).toEqual({ row: 'tablist', pill: 'tab' });
  });
});
