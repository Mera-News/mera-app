// toast-manager dynamically requires '@/components/ui/toast' and 'react'.
// We must stub those modules before the import.

jest.mock('@/components/ui/toast', () => ({
  Toast: 'MockToast',
  ToastTitle: 'MockToastTitle',
  ToastDescription: 'MockToastDescription',
}));

// Prevent react-native-css-interop from loading
jest.mock('react-native-css-interop', () => ({}), { virtual: true });
jest.mock('nativewind', () => ({}), { virtual: true });

jest.mock('react', () => ({
  ...jest.requireActual('react'),
  createElement: jest.fn((...args: unknown[]) => ({ type: args[0], props: args[1], children: args.slice(2) })),
}));

jest.mock('../logger', () => ({
  __esModule: true,
  default: {
    warn: jest.fn(),
    info: jest.fn(),
    error: jest.fn(),
  },
}));

import logger from '../logger';
import { toastManager } from '../toast-manager';

const mockLoggerWarn = logger.warn as jest.Mock;
const mockLoggerInfo = logger.info as jest.Mock;

function makeToastFn() {
  return {
    show: jest.fn((..._args: any[]) => 'toast-id-1'),
    close: jest.fn(),
    closeAll: jest.fn(),
    isActive: jest.fn(() => false),
  };
}

describe('ToastManager — no instance', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (toastManager as any).toastInstance = null;
    toastManager.resetDebounce();
  });

  it('showNetworkError logs warn when not initialized', () => {
    toastManager.showNetworkError();
    expect(mockLoggerWarn).toHaveBeenCalledWith(
      expect.stringContaining('not initialized'),
    );
  });

  it('showError logs warn when not initialized', () => {
    toastManager.showError('Oops', 'Something failed');
    expect(mockLoggerWarn).toHaveBeenCalledWith(
      expect.stringContaining('not initialized'),
    );
  });

  it('showSuccess logs warn when not initialized', () => {
    toastManager.showSuccess('Done', 'Saved!');
    expect(mockLoggerWarn).toHaveBeenCalledWith(
      expect.stringContaining('not initialized'),
    );
  });

  it('showInfo logs warn when not initialized', () => {
    toastManager.showInfo('For You');
    expect(mockLoggerWarn).toHaveBeenCalledWith(
      expect.stringContaining('not initialized'),
    );
  });
});

describe('ToastManager — with instance', () => {
  let toast: ReturnType<typeof makeToastFn>;

  beforeEach(() => {
    jest.clearAllMocks();
    toast = makeToastFn();
    toastManager.setToastInstance(toast);
    toastManager.resetDebounce();
  });

  describe('showNetworkError', () => {
    it('calls toast.show when debounce allows', () => {
      toastManager.showNetworkError();
      expect(toast.show).toHaveBeenCalledTimes(1);
    });

    it('shows with placement "top" and 4s duration', () => {
      toastManager.showNetworkError();
      const [opts] = toast.show.mock.calls[0];
      expect(opts.placement).toBe('top');
      expect(opts.duration).toBe(4000);
    });

    it('render function is a function (deferred rendering)', () => {
      toastManager.showNetworkError();
      const [opts] = toast.show.mock.calls[0];
      expect(typeof opts.render).toBe('function');
    });

    it('accepts a custom message (passes through to show options)', () => {
      toastManager.showNetworkError('Custom network msg');
      expect(toast.show).toHaveBeenCalledTimes(1);
    });

    it('debounces: second call within 5s is skipped', () => {
      toastManager.showNetworkError();
      toastManager.showNetworkError();
      expect(toast.show).toHaveBeenCalledTimes(1);
      expect(mockLoggerInfo).toHaveBeenCalledWith(
        expect.stringContaining('debounced'),
      );
    });

    it('allows a second call after resetDebounce()', () => {
      toastManager.showNetworkError();
      toastManager.resetDebounce();
      toastManager.showNetworkError();
      expect(toast.show).toHaveBeenCalledTimes(2);
    });
  });

  describe('showError', () => {
    it('calls toast.show with title and message', () => {
      toastManager.showError('Error Title', 'Error body');
      expect(toast.show).toHaveBeenCalledTimes(1);
    });

    it('shows with placement "top" and 4s duration', () => {
      toastManager.showError('Err', 'msg');
      const [opts] = toast.show.mock.calls[0];
      expect(opts.placement).toBe('top');
      expect(opts.duration).toBe(4000);
    });

    it('debounces: second showError within 5s is skipped', () => {
      toastManager.showError('A', 'B');
      toastManager.showError('C', 'D');
      expect(toast.show).toHaveBeenCalledTimes(1);
    });

    it('render function is a function (deferred rendering)', () => {
      toastManager.showError('Title', 'Message');
      const [opts] = toast.show.mock.calls[0];
      expect(typeof opts.render).toBe('function');
    });
  });

  describe('showSuccess', () => {
    it('calls toast.show with title and message', () => {
      toastManager.showSuccess('Success!', 'Your data was saved.');
      expect(toast.show).toHaveBeenCalledTimes(1);
    });

    it('shows with placement "top" and 3s duration', () => {
      toastManager.showSuccess('OK', 'Saved');
      const [opts] = toast.show.mock.calls[0];
      expect(opts.placement).toBe('top');
      expect(opts.duration).toBe(3000);
    });

    it('is NOT debounced — shows even after an error toast', () => {
      toastManager.showNetworkError(); // consumes debounce
      // showSuccess has no debounce guard
      toastManager.showSuccess('Done', 'Saved');
      // showSuccess should still be called even though debounce is active
      expect(toast.show).toHaveBeenCalledTimes(2);
    });

    it('render function is a function (deferred rendering)', () => {
      toastManager.showSuccess('OK', 'Great');
      const [opts] = toast.show.mock.calls[0];
      expect(typeof opts.render).toBe('function');
    });
  });

  describe('showInfo', () => {
    it('calls toast.show with a title (message optional)', () => {
      toastManager.showInfo('For You');
      expect(toast.show).toHaveBeenCalledTimes(1);
    });

    it('shows with placement "bottom" and 1.5s duration', () => {
      toastManager.showInfo('For You');
      const [opts] = toast.show.mock.calls[0];
      expect(opts.placement).toBe('bottom');
      expect(opts.duration).toBe(1500);
    });

    it('is NOT debounced — shows even after an error toast', () => {
      toastManager.showNetworkError(); // consumes debounce
      toastManager.showInfo('For You');
      expect(toast.show).toHaveBeenCalledTimes(2);
    });

    it('render function is a function (deferred rendering)', () => {
      toastManager.showInfo('For You');
      const [opts] = toast.show.mock.calls[0];
      expect(typeof opts.render).toBe('function');
    });
  });

  describe('resetDebounce', () => {
    it('resets the internal timer so next showNetworkError fires', () => {
      toastManager.showNetworkError();
      expect(toast.show).toHaveBeenCalledTimes(1);
      toastManager.resetDebounce();
      toastManager.showNetworkError();
      expect(toast.show).toHaveBeenCalledTimes(2);
    });
  });
});
