// RN's ActivityIndicator loads under the integration setup (its native spec is a host-string stub),
// and RNTL's async utilities wait 5 s by default.
import { getConfig } from '@testing-library/react-native/build/config';

it('ActivityIndicator loads and RNTL waits 5 s', () => {
  expect(require('react-native').ActivityIndicator).toBeDefined();
  expect(getConfig().asyncUtilTimeout).toBe(5000);
});

it('the shared reanimated mock carries useComposedEventHandler', () => {
  expect(typeof require('react-native-reanimated').useComposedEventHandler).toBe('function');
});
