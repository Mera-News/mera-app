// Barrel/smoke test for mera-protocol-toolkit/index.ts
// Verifies all expected exports are present and are the right type.

// Mock all transitive deps so we don't hit native modules
jest.mock('llama.rn', () => ({
  initLlama: jest.fn(),
  releaseAllLlama: jest.fn(),
  loadLlamaModelInfo: jest.fn(),
  addNativeLogListener: jest.fn(() => ({ remove: jest.fn() })),
  toggleNativeLog: jest.fn(),
}));

jest.mock('@dr.pogodin/react-native-fs', () => ({
  DocumentDirectoryPath: '/tmp/mera-test',
  CachesDirectoryPath: '/tmp/mera-test-cache',
  exists: jest.fn(() => Promise.resolve(false)),
  mkdir: jest.fn(() => Promise.resolve()),
  unlink: jest.fn(() => Promise.resolve()),
  stat: jest.fn(() => Promise.resolve({ size: 0 })),
  downloadFile: jest.fn(() => ({
    jobId: 1,
    promise: Promise.resolve({ statusCode: 200, bytesWritten: 0 }),
  })),
  stopDownload: jest.fn(),
  getFSInfo: jest.fn(() => Promise.resolve({ freeSpace: 10 * 1024 * 1024 * 1024 })),
}));

jest.mock('expo-file-system', () => ({
  Directory: jest.fn(() => ({
    exists: jest.fn(() => false),
    create: jest.fn(),
    uri: '/tmp/test-dir/',
  })),
  File: jest.fn(() => ({
    exists: jest.fn(() => false),
    write: jest.fn(),
    text: jest.fn(() => '{}'),
    delete: jest.fn(),
    uri: '/tmp/test-file',
  })),
  Paths: { cache: '/tmp/cache' },
}));

jest.mock('expo-crypto', () => ({
  digestStringAsync: jest.fn(() => Promise.resolve('deadbeef')),
  CryptoDigestAlgorithm: { SHA256: 'SHA-256' },
  CryptoEncoding: { HEX: 'hex' },
}));

jest.mock('@/lib/logger', () => ({
  __esModule: true,
  default: { warn: jest.fn(), error: jest.fn(), info: jest.fn(), captureException: jest.fn() },
}));

jest.mock('@/lib/stores/mera-protocol-store', () => ({
  useMeraProtocolStore: {
    getState: jest.fn(() => ({
      setModelState: jest.fn(),
      modelState: null,
    })),
    setState: jest.fn(),
  },
}));

// Import the barrel
import * as toolkit from '../index';

describe('mera-protocol-toolkit barrel exports', () => {
  describe('Core Inference', () => {
    it('exports infer as a function', () => {
      expect(typeof toolkit.infer).toBe('function');
    });

    it('exports inferStream as a function (async generator factory)', () => {
      expect(typeof toolkit.inferStream).toBe('function');
    });
  });

  describe('Base Model Lifecycle', () => {
    it('exports downloadBaseModel', () => {
      expect(typeof toolkit.downloadBaseModel).toBe('function');
    });

    it('exports initBaseModel', () => {
      expect(typeof toolkit.initBaseModel).toBe('function');
    });

    it('exports disposeModel', () => {
      expect(typeof toolkit.disposeModel).toBe('function');
    });

    it('exports resetContext', () => {
      expect(typeof toolkit.resetContext).toBe('function');
    });

    it('exports getModelState', () => {
      expect(typeof toolkit.getModelState).toBe('function');
    });

    it('exports isModelDownloaded', () => {
      expect(typeof toolkit.isModelDownloaded).toBe('function');
    });

    it('exports deleteBaseModel', () => {
      expect(typeof toolkit.deleteBaseModel).toBe('function');
    });

    it('exports purgeAllBaseModels', () => {
      expect(typeof toolkit.purgeAllBaseModels).toBe('function');
    });
  });

  describe('Adapter Lifecycle', () => {
    it('exports downloadAdapter', () => {
      expect(typeof toolkit.downloadAdapter).toBe('function');
    });

    it('exports loadAdapter', () => {
      expect(typeof toolkit.loadAdapter).toBe('function');
    });

    it('exports unloadAdapter', () => {
      expect(typeof toolkit.unloadAdapter).toBe('function');
    });

    it('exports listAdapters', () => {
      expect(typeof toolkit.listAdapters).toBe('function');
    });

    it('exports deleteAdapter', () => {
      expect(typeof toolkit.deleteAdapter).toBe('function');
    });
  });

  describe('Download Service', () => {
    it('exports startModelDownload', () => {
      expect(typeof toolkit.startModelDownload).toBe('function');
    });

    it('exports cancelModelDownload', () => {
      expect(typeof toolkit.cancelModelDownload).toBe('function');
    });

    it('exports isDownloadInProgress', () => {
      expect(typeof toolkit.isDownloadInProgress).toBe('function');
    });
  });

  describe('System Requirements', () => {
    it('exports checkRequirements', () => {
      expect(typeof toolkit.checkRequirements).toBe('function');
    });
  });
});
