// GATE (b): the provider resolves DARK with the theme store at its default, and
// the swap is driven by our resolved mode rather than by native colour scheme.
//
// This is the phase's real assurance that deleting 28 wrappers changed nothing:
// with the store untouched, the style the provider applies must be exactly the
// dark token block it applied before.
//
// SCOPE, STATED HONESTLY. This renders the PROVIDER, not each of the eight
// screen families end to end. Mounting those screens in jest pulls their full
// module graphs (WatermelonDB, reanimated, expo-updates, native attest) and the
// resulting test would assert mock behaviour rather than theme behaviour. The
// per-screen claim that matters after a wrapper deletion is structural, "this
// screen no longer supplies its own scheme", and that is asserted below by file
// and again in single-provider.test.ts. The pixel claim is the user-run
// on-device diff, which this cannot replace.

import { render } from '@testing-library/react-native';
import React from 'react';
import { Text } from 'react-native';

import { useThemeStore } from '@/lib/stores/theme-store';

import { config } from '../config';
import { GluestackUIProvider } from '../index';

// Only `useColorScheme` is stubbed; `vars()` stays REAL so the style objects
// under test are the ones production builds. nativewind's setColorScheme throws
// under jest ("Unable to manually set color scheme without using darkMode:
// class") because jest never processes the compiled tailwind config, even though
// tailwind.config.js does set darkMode:'class'. That is a test-environment
// artefact and predates this phase: the previous provider called it the same way,
// which is why every existing suite mocks the provider wholesale rather than
// rendering it.
jest.mock('nativewind', () => ({
  ...jest.requireActual('nativewind'),
  useColorScheme: () => ({ colorScheme: 'dark', setColorScheme: jest.fn() }),
}));

jest.mock('@gluestack-ui/core/overlay/creator', () => ({
  OverlayProvider: ({ children }: { children: React.ReactNode }) => children,
}));
jest.mock('@gluestack-ui/core/toast/creator', () => ({
  ToastProvider: ({ children }: { children: React.ReactNode }) => children,
}));

/**
 * The provider's style prop, flattened to the array of entries it was given.
 *
 * NOT compared by key/value: nativewind's `vars()` does not return a plain
 * object of CSS variables, so `Object.entries()` on it yields NOTHING. An
 * earlier version of this test looped over those zero entries and passed
 * vacuously — it only surfaced because of the `dark !== light` guard below.
 * Reference identity is the honest assertion: it proves the provider handed the
 * style system the block for THIS mode.
 */
function styleEntries(tree: ReturnType<typeof render>): unknown[] {
  const style = tree.UNSAFE_root.findByType('View' as never).props.style;
  return Array.isArray(style) ? style.flat(Infinity) : [style];
}

function renderProviderAt(mode: 'light' | 'dark') {
  return render(
    <GluestackUIProvider mode={mode}>
      <Text testID="probe">probe</Text>
    </GluestackUIProvider>,
  );
}

beforeEach(() => {
  useThemeStore.getState().reset();
});

describe('the store default is dark', () => {
  it('resolves dark before anything hydrates', () => {
    expect(useThemeStore.getState().resolved).toBe('dark');
  });

  it('the two token blocks are distinct objects, so the checks below can fail', () => {
    expect(config.dark).not.toBe(config.light);
  });

  it('applies the dark block at the store default, and not the light one', () => {
    const tree = renderProviderAt(useThemeStore.getState().resolved);
    expect(tree.getByTestId('probe')).toBeTruthy();
    const entries = styleEntries(tree);
    expect(entries).toContain(config.dark);
    expect(entries).not.toContain(config.light);
  });
});

describe('render follows the resolved mode, not native state', () => {
  it('a light resolution applies the light block instead', () => {
    useThemeStore.setState({ preference: 'light', resolved: 'light' });
    const entries = styleEntries(renderProviderAt(useThemeStore.getState().resolved));
    expect(entries).toContain(config.light);
    expect(entries).not.toContain(config.dark);
  });
});

describe('the deleted-wrapper screen families supply no scheme of their own', () => {
  // One entry per family named for this phase. A wrapper reappearing in any of
  // them is the regression this phase can actually cause.
  const FAMILIES = [
    'app/logged-in/article-detail.tsx',
    'app/logged-in/sources.tsx',
    'app/logged-in/persona-audit.tsx',
    'app/tutorials/index.tsx',
    'components/custom/config-mera/ManageDataScreen.tsx',
    'components/custom/config-mera/NotificationSettingsScreen.tsx',
    'components/custom/config-mera/MeraProtocolSettingsScreen.tsx',
    'app/logged-in/notifications.tsx',
    'app/logged-in/saved-suggestions.tsx',
    'app/logged-in/profile-advanced.tsx',
  ];

  it.each(FAMILIES)('%s renders no GluestackUIProvider', (rel) => {
    const fs = require('node:fs') as typeof import('node:fs');
    const path = require('node:path') as typeof import('node:path');
    const src = fs.readFileSync(path.resolve(__dirname, '../../../..', rel), 'utf8');
    expect(src).not.toContain('<GluestackUIProvider');
  });
});
