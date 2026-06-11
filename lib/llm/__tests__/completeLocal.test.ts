// completeLocal.test.ts — unit tests for lib/llm/completeLocal.ts
// ALL jest.mock() calls MUST appear before any import statements.

const mockGetModelState = jest.fn();
const mockInfer = jest.fn();
const mockInitBaseModel = jest.fn();

jest.mock('@/lib/mera-protocol-toolkit', () => ({
  getModelState: (...args: unknown[]) => mockGetModelState(...args),
  infer: (...args: unknown[]) => mockInfer(...args),
  initBaseModel: (...args: unknown[]) => mockInitBaseModel(...args),
}));

const mockSetModelState = jest.fn();
const mockGetState = jest.fn();

jest.mock('@/lib/stores/mera-protocol-store', () => ({
  useMeraProtocolStore: {
    getState: (...args: unknown[]) => mockGetState(...args),
  },
}));

import { completeLocal } from '../completeLocal';

describe('completeLocal', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetState.mockReturnValue({ setModelState: mockSetModelState });
    mockInitBaseModel.mockResolvedValue(undefined);
  });

  describe('model initialization', () => {
    it('does NOT init the model when getModelState() returns a non-null value', async () => {
      mockGetModelState.mockReturnValue('ready');
      mockInfer.mockResolvedValue({ output: 'hello world' });

      await completeLocal({ systemPrompt: 'sys', prompt: 'user' });

      expect(mockInitBaseModel).not.toHaveBeenCalled();
      expect(mockSetModelState).not.toHaveBeenCalled();
    });

    it('inits the model when getModelState() returns null (lazy-init branch)', async () => {
      mockGetModelState.mockReturnValue(null);
      mockInfer.mockResolvedValue({ output: 'hello world' });

      await completeLocal({ systemPrompt: 'sys', prompt: 'user' });

      expect(mockSetModelState).toHaveBeenCalledWith('loading');
      expect(mockInitBaseModel).toHaveBeenCalled();
      expect(mockSetModelState).toHaveBeenCalledWith('ready');
      // 'loading' before init, 'ready' after
      expect(mockSetModelState.mock.calls[0][0]).toBe('loading');
      expect(mockSetModelState.mock.calls[1][0]).toBe('ready');
    });
  });

  describe('output post-processing', () => {
    it('strips <think>…</think> blocks and trims whitespace', async () => {
      mockGetModelState.mockReturnValue('ready');
      mockInfer.mockResolvedValue({
        output: '  <think>some reasoning here</think>  actual answer  ',
      });

      const result = await completeLocal({ systemPrompt: 'sys', prompt: 'user' });

      expect(result).toBe('actual answer');
    });

    it('strips multi-line <think> blocks', async () => {
      mockGetModelState.mockReturnValue('ready');
      mockInfer.mockResolvedValue({
        output: '<think>\nline1\nline2\n</think>\nfinal answer',
      });

      const result = await completeLocal({ systemPrompt: 'sys', prompt: 'user' });

      expect(result).toBe('final answer');
    });

    it('strips multiple <think> blocks', async () => {
      mockGetModelState.mockReturnValue('ready');
      mockInfer.mockResolvedValue({
        output: '<think>block1</think> text <think>block2</think> end',
      });

      const result = await completeLocal({ systemPrompt: 'sys', prompt: 'user' });

      expect(result).toBe('text  end');
    });

    it('returns trimmed output with no think blocks', async () => {
      mockGetModelState.mockReturnValue('ready');
      mockInfer.mockResolvedValue({ output: '   clean output   ' });

      const result = await completeLocal({ systemPrompt: 'sys', prompt: 'user' });

      expect(result).toBe('clean output');
    });

    it('returns empty string when output is only think blocks', async () => {
      mockGetModelState.mockReturnValue('ready');
      mockInfer.mockResolvedValue({ output: '<think>all reasoning</think>' });

      const result = await completeLocal({ systemPrompt: 'sys', prompt: 'user' });

      expect(result).toBe('');
    });
  });

  describe('request forwarding', () => {
    it('passes default maxTokens=512 and temperature=0.3 when not specified', async () => {
      mockGetModelState.mockReturnValue('ready');
      mockInfer.mockResolvedValue({ output: 'result' });

      await completeLocal({ systemPrompt: 'sys', prompt: 'u' });

      expect(mockInfer).toHaveBeenCalledWith(
        expect.objectContaining({
          systemPrompt: 'sys',
          prompt: 'u',
          maxTokens: 512,
          temperature: 0.3,
          responseFormat: undefined,
          enableThinking: undefined,
        }),
      );
    });

    it('forwards explicit maxTokens and temperature', async () => {
      mockGetModelState.mockReturnValue('ready');
      mockInfer.mockResolvedValue({ output: '' });

      await completeLocal({
        systemPrompt: 'sys',
        prompt: 'u',
        maxTokens: 256,
        temperature: 0.7,
      });

      expect(mockInfer).toHaveBeenCalledWith(
        expect.objectContaining({ maxTokens: 256, temperature: 0.7 }),
      );
    });

    it('maps responseFormat "json" to "json" for localInfer', async () => {
      mockGetModelState.mockReturnValue('ready');
      mockInfer.mockResolvedValue({ output: '{}' });

      await completeLocal({
        systemPrompt: 'sys',
        prompt: 'u',
        responseFormat: 'json',
      });

      expect(mockInfer).toHaveBeenCalledWith(
        expect.objectContaining({ responseFormat: 'json' }),
      );
    });

    it('maps responseFormat "text" to undefined for localInfer', async () => {
      mockGetModelState.mockReturnValue('ready');
      mockInfer.mockResolvedValue({ output: 'text result' });

      await completeLocal({
        systemPrompt: 'sys',
        prompt: 'u',
        responseFormat: 'text',
      });

      expect(mockInfer).toHaveBeenCalledWith(
        expect.objectContaining({ responseFormat: undefined }),
      );
    });

    it('forwards enableThinking flag', async () => {
      mockGetModelState.mockReturnValue('ready');
      mockInfer.mockResolvedValue({ output: '' });

      await completeLocal({
        systemPrompt: 'sys',
        prompt: 'u',
        enableThinking: true,
      });

      expect(mockInfer).toHaveBeenCalledWith(
        expect.objectContaining({ enableThinking: true }),
      );
    });
  });

  describe('error handling', () => {
    it('propagates errors from localInfer', async () => {
      mockGetModelState.mockReturnValue('ready');
      mockInfer.mockRejectedValue(new Error('llama crash'));

      await expect(
        completeLocal({ systemPrompt: 'sys', prompt: 'u' }),
      ).rejects.toThrow('llama crash');
    });

    it('propagates errors from initBaseModel', async () => {
      mockGetModelState.mockReturnValue(null);
      mockInitBaseModel.mockRejectedValue(new Error('load failed'));

      await expect(
        completeLocal({ systemPrompt: 'sys', prompt: 'u' }),
      ).rejects.toThrow('load failed');
    });
  });
});
