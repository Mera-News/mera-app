// Drivable AppState with RN mock API parity. Replaces
// react-native/Libraries/AppState/AppState in the integration project.
type State = 'active' | 'background' | 'inactive';
type Listener = (state: State) => void;

const listeners = new Set<Listener>();

export const appStateModule = {
  currentState: 'active' as State,
  isAvailable: true,
  addEventListener(type: string, fn: Listener) {
    if (type === 'change') listeners.add(fn);
    return { remove: () => listeners.delete(fn) };
  },
  removeEventListener(type: string, fn: Listener) {
    if (type === 'change') listeners.delete(fn);
  },
};

/** Sets AppState.currentState and calls every 'change' listener with it. */
export function setAppState(state: State): void {
  appStateModule.currentState = state;
  [...listeners].forEach((fn) => fn(state));
}
