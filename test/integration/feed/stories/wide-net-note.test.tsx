// The followed-story page's wide-net note: one line, Learn more opens the reason and how to
// remove an article, Show less closes it. Real en copy, so the remove line names the same
// menu action the article's ••• sheet shows.
import { fireEvent, render } from '@testing-library/react-native';
import React from 'react';
import WideNetNote from '@/components/custom/tracked-stories/WideNetNote';
import i18n from '@/lib/i18n';
import { initI18nEn } from '@/test/helpers';
import '@/test/helpers';

beforeAll(() => initI18nEn());

it('opens to the reason and the remove hint, and closes again', () => {
  const view = render(<WideNetNote />);
  expect(view.getByText(i18n.t('trackedStories.wideNetLine'))).toBeTruthy();
  expect(view.queryByText(i18n.t('trackedStories.wideNetBody'))).toBeNull();

  const more = view.getByTestId('story-wide-net-more');
  expect(more.props.accessibilityState).toMatchObject({ expanded: false });
  fireEvent.press(more);

  expect(view.getByText(i18n.t('trackedStories.wideNetBody'))).toBeTruthy();
  const remove = i18n.t('trackedStories.wideNetRemove', { action: i18n.t('trackedStories.removeMemberAction') });
  expect(remove).toContain('Not part of this story');
  expect(view.getByText(remove)).toBeTruthy();
  expect(view.getByTestId('story-wide-net-less').props.accessibilityState).toMatchObject({ expanded: true });

  fireEvent.press(view.getByTestId('story-wide-net-less'));
  expect(view.queryByText(i18n.t('trackedStories.wideNetBody'))).toBeNull();
  expect(view.getByTestId('story-wide-net')).toBeTruthy();
});
