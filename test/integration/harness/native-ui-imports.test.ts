// Shared UI that pulls native modules loads under the integration setup (gesture-handler's own Jest
// mocks plus the RN Switch spec stubs), so hook tests reaching it need no local mocks.
it('components/ui/bottom-sheet and react-native-gesture-handler load', () => {
  expect(require('react-native-gesture-handler').GestureDetector).toBeDefined();
  expect(require('@/components/ui/bottom-sheet')).toBeTruthy();
});
