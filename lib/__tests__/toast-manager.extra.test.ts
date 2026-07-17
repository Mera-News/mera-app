// Supplemental tests for toast-manager.ts.
// The primary toast-manager.test.ts verifies show() is called and opts.render
// is a function, but does NOT invoke the render callbacks.
// These tests invoke the render functions to cover lines 80, 112, 138
// (the React.createElement bodies).

jest.mock('@/components/ui/toast', () => ({
  Toast: 'MockToast',
  ToastTitle: 'MockToastTitle',
  ToastDescription: 'MockToastDescription',
}));

// react-native-css-interop wraps createElement — provide a stub that passes through
jest.mock('react-native-css-interop', () => ({
  createInteropElement: jest.fn(
    (type: unknown, props: unknown, ...children: unknown[]) => ({
      type,
      props,
      children,
    }),
  ),
}), { virtual: true });

jest.mock('nativewind', () => ({}), { virtual: true });

// Spy on React.createElement so we can track calls inside the render callbacks
const React = jest.requireActual('react');
const mockCreateElement = jest.spyOn(React, 'createElement').mockImplementation(
  (type: unknown, props: unknown, ...children: unknown[]) => ({
    type,
    props,
    children,
  }) as any,
);

jest.mock('react', () => ({
  ...jest.requireActual('react'),
  createElement: jest.fn(
    (type: unknown, props: unknown, ...children: unknown[]) => ({
      type,
      props,
      children,
    }),
  ),
}));

jest.mock('../logger', () => ({
  __esModule: true,
  default: {
    warn: jest.fn(),
    info: jest.fn(),
    error: jest.fn(),
  },
}));

import { toastManager } from '../toast-manager';

function makeToastFn() {
  return {
    show: jest.fn((..._args: any[]) => 'toast-id'),
    close: jest.fn(),
    closeAll: jest.fn(),
    isActive: jest.fn(() => false),
  };
}

describe('ToastManager render callback bodies', () => {
  let toast: ReturnType<typeof makeToastFn>;

  beforeEach(() => {
    jest.clearAllMocks();
    toast = makeToastFn();
    toastManager.setToastInstance(toast);
    toastManager.resetDebounce();
  });

  describe('showNetworkError render function (line 80)', () => {
    it('render function does not throw and returns a value', () => {
      toastManager.showNetworkError();
      const [opts] = toast.show.mock.calls[0];
      // Invoke the render function — covers line 80
      let result: unknown;
      expect(() => { result = opts.render({ id: 'toast-1' }); }).not.toThrow();
      expect(result).toBeTruthy();
    });

    it('render function result has type MockToast as root element', () => {
      toastManager.showNetworkError();
      const [opts] = toast.show.mock.calls[0];
      const result = opts.render({ id: 'toast-1' }) as any;
      // The root element should be the Toast component (aliased as 'MockToast')
      expect(result.type).toBe('MockToast');
    });

    it('render function uses the default network error message', () => {
      toastManager.showNetworkError();
      const [opts] = toast.show.mock.calls[0];
      const result = opts.render({ id: 'toast-1' }) as any;
      // One of the children should contain the ToastDescription with the default message
      const descElement = result.children.find((c: any) => c?.type === 'MockToastDescription');
      expect(descElement).toBeDefined();
      expect(descElement.children[0]).toContain('Unable to connect');
    });

    it('render function uses custom message when provided', () => {
      toastManager.showNetworkError('Custom network error message');
      const [opts] = toast.show.mock.calls[0];
      const result = opts.render({ id: 'toast-2' }) as any;
      const descElement = result.children.find((c: any) => c?.type === 'MockToastDescription');
      expect(descElement).toBeDefined();
      expect(descElement.children[0]).toBe('Custom network error message');
    });

    it('render function root has action=error prop', () => {
      toastManager.showNetworkError();
      const [opts] = toast.show.mock.calls[0];
      const result = opts.render({ id: 'toast-3' }) as any;
      expect((result.props as any).action).toBe('error');
    });

    it('render function root has variant=solid prop', () => {
      toastManager.showNetworkError();
      const [opts] = toast.show.mock.calls[0];
      const result = opts.render({ id: 'toast-4' }) as any;
      expect((result.props as any).variant).toBe('solid');
    });

    it('render function includes ToastTitle with "Network Error"', () => {
      toastManager.showNetworkError();
      const [opts] = toast.show.mock.calls[0];
      const result = opts.render({ id: 'toast-5' }) as any;
      const titleElement = result.children.find((c: any) => c?.type === 'MockToastTitle');
      expect(titleElement).toBeDefined();
      expect(titleElement.children[0]).toBe('Network Error');
    });
  });

  describe('showError render function (line 112)', () => {
    it('render function does not throw and returns a value', () => {
      toastManager.showError('Error Title', 'Error body');
      const [opts] = toast.show.mock.calls[0];
      let result: unknown;
      expect(() => { result = opts.render({ id: 'toast-6' }); }).not.toThrow();
      expect(result).toBeTruthy();
    });

    it('render function root has type MockToast', () => {
      toastManager.showError('Title', 'Message');
      const [opts] = toast.show.mock.calls[0];
      const result = opts.render({ id: 'toast-6' }) as any;
      expect(result.type).toBe('MockToast');
    });

    it('render function uses action=error', () => {
      toastManager.showError('Err', 'msg');
      const [opts] = toast.show.mock.calls[0];
      const result = opts.render({ id: 'toast-7' }) as any;
      expect((result.props as any).action).toBe('error');
    });

    it('render function includes ToastTitle with the provided title', () => {
      toastManager.showError('My Error', 'My Message');
      const [opts] = toast.show.mock.calls[0];
      const result = opts.render({ id: 'toast-8' }) as any;
      const titleElement = result.children.find((c: any) => c?.type === 'MockToastTitle');
      expect(titleElement).toBeDefined();
      expect(titleElement.children[0]).toBe('My Error');
    });

    it('render function includes ToastDescription with the provided message', () => {
      toastManager.showError('My Error', 'My Message');
      const [opts] = toast.show.mock.calls[0];
      const result = opts.render({ id: 'toast-9' }) as any;
      const descElement = result.children.find((c: any) => c?.type === 'MockToastDescription');
      expect(descElement).toBeDefined();
      expect(descElement.children[0]).toBe('My Message');
    });
  });

  describe('showSuccess render function (line 138)', () => {
    it('render function does not throw and returns a value', () => {
      toastManager.showSuccess('Done', 'All saved');
      const [opts] = toast.show.mock.calls[0];
      let result: unknown;
      expect(() => { result = opts.render({ id: 'toast-10' }); }).not.toThrow();
      expect(result).toBeTruthy();
    });

    it('render function root has type MockToast', () => {
      toastManager.showSuccess('OK', 'Saved');
      const [opts] = toast.show.mock.calls[0];
      const result = opts.render({ id: 'toast-11' }) as any;
      expect(result.type).toBe('MockToast');
    });

    it('render function uses action=success (differs from error toasts)', () => {
      toastManager.showSuccess('Done', 'All saved');
      const [opts] = toast.show.mock.calls[0];
      const result = opts.render({ id: 'toast-12' }) as any;
      expect((result.props as any).action).toBe('success');
    });

    it('render function includes ToastTitle with the provided title', () => {
      toastManager.showSuccess('Great Job!', 'Everything is fine');
      const [opts] = toast.show.mock.calls[0];
      const result = opts.render({ id: 'toast-13' }) as any;
      const titleElement = result.children.find((c: any) => c?.type === 'MockToastTitle');
      expect(titleElement).toBeDefined();
      expect(titleElement.children[0]).toBe('Great Job!');
    });

    it('render function includes ToastDescription with the provided message', () => {
      toastManager.showSuccess('Great Job!', 'Everything is fine');
      const [opts] = toast.show.mock.calls[0];
      const result = opts.render({ id: 'toast-14' }) as any;
      const descElement = result.children.find((c: any) => c?.type === 'MockToastDescription');
      expect(descElement).toBeDefined();
      expect(descElement.children[0]).toBe('Everything is fine');
    });
  });

  describe('showInfo render function', () => {
    it('render function does not throw and returns a value', () => {
      toastManager.showInfo('For You');
      const [opts] = toast.show.mock.calls[0];
      let result: unknown;
      expect(() => { result = opts.render({ id: 'toast-15' }); }).not.toThrow();
      expect(result).toBeTruthy();
    });

    it('render function root has type MockToast and action=info', () => {
      toastManager.showInfo('For You');
      const [opts] = toast.show.mock.calls[0];
      const result = opts.render({ id: 'toast-16' }) as any;
      expect(result.type).toBe('MockToast');
      expect((result.props as any).action).toBe('info');
    });

    it('render function includes ToastTitle with the provided title', () => {
      toastManager.showInfo('For You');
      const [opts] = toast.show.mock.calls[0];
      const result = opts.render({ id: 'toast-17' }) as any;
      const titleElement = result.children.find((c: any) => c?.type === 'MockToastTitle');
      expect(titleElement).toBeDefined();
      expect(titleElement.children[0]).toBe('For You');
    });

    it('render function omits ToastDescription when no message is given', () => {
      toastManager.showInfo('For You');
      const [opts] = toast.show.mock.calls[0];
      const result = opts.render({ id: 'toast-18' }) as any;
      const descElement = result.children.find((c: any) => c?.type === 'MockToastDescription');
      expect(descElement).toBeUndefined();
    });

    it('render function includes ToastDescription when a message is given', () => {
      toastManager.showInfo('For You', 'Long-press hint');
      const [opts] = toast.show.mock.calls[0];
      const result = opts.render({ id: 'toast-19' }) as any;
      const descElement = result.children.find((c: any) => c?.type === 'MockToastDescription');
      expect(descElement).toBeDefined();
      expect(descElement.children[0]).toBe('Long-press hint');
    });
  });
});
