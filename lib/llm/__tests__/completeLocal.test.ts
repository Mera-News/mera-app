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

import { completeLocal, LocalTruncatedReasoningError } from '../completeLocal';

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

  // r12 P0b — a LIVE production defect. Local topic generation runs with
  // enableThinking:true; when the reasoning trace exhausted the (previously 400)
  // token budget the model stopped mid-<think>, the strip regex (which needs a
  // CLOSING tag) matched nothing, and the raw trace was returned as `output`.
  // The caller's JSON parser then found no array and the user was told
  // "no usable topics" for a fact that had generated fine.
  describe('truncated reasoning (P0b)', () => {
    it('throws on an unclosed <think> instead of returning the trace as output', async () => {
      mockGetModelState.mockReturnValue('ready');
      mockInfer.mockResolvedValue({
        output: '<think>I should list topics about Bhopal, starting with loc',
      });

      await expect(
        completeLocal({ systemPrompt: 'sys', prompt: 'u', enableThinking: true }),
      ).rejects.toThrow(LocalTruncatedReasoningError);
    });

    it('names the budget in the error so the fix is obvious', async () => {
      mockGetModelState.mockReturnValue('ready');
      mockInfer.mockResolvedValue({ output: '<think>reasoning cut off' });

      await expect(
        completeLocal({ systemPrompt: 'sys', prompt: 'u', maxTokens: 400 }),
      ).rejects.toThrow(/maxTokens=400/);
    });

    it('throws when llama.rn reports truncation and nothing usable remains', async () => {
      mockGetModelState.mockReturnValue('ready');
      mockInfer.mockResolvedValue({ output: '   ', truncated: true });

      await expect(
        completeLocal({ systemPrompt: 'sys', prompt: 'u' }),
      ).rejects.toThrow(LocalTruncatedReasoningError);
    });

    it('returns a truncated-but-substantive answer rather than throwing', async () => {
      mockGetModelState.mockReturnValue('ready');
      mockInfer.mockResolvedValue({ output: '["a","b"', truncated: true });

      const result = await completeLocal({ systemPrompt: 'sys', prompt: 'u' });

      expect(result).toBe('["a","b"');
    });

    it('does not throw for a well-formed think block (the normal case)', async () => {
      mockGetModelState.mockReturnValue('ready');
      mockInfer.mockResolvedValue({ output: '<think>done</think>["a"]' });

      await expect(
        completeLocal({ systemPrompt: 'sys', prompt: 'u' }),
      ).resolves.toBe('["a"]');
    });

    it('handles the chat-template PREFILL shape: a closer with no opener', async () => {
      // The Qwen3 template can inject the opening <think> into the PROMPT, so a
      // successful generation comes back as `reasoning</think>answer`. That is a
      // success path, not a truncation.
      mockGetModelState.mockReturnValue('ready');
      mockInfer.mockResolvedValue({
        output: 'let me think about this</think>\n["topic one"]',
      });

      const result = await completeLocal({
        systemPrompt: 'sys',
        prompt: 'u',
        enableThinking: true,
      });

      expect(result).toBe('["topic one"]');
    });

    it('uses the LAST closer when reasoning mentions the tag', async () => {
      mockGetModelState.mockReturnValue('ready');
      mockInfer.mockResolvedValue({
        output: 'first</think>middle</think>["final"]',
      });

      const result = await completeLocal({ systemPrompt: 'sys', prompt: 'u' });

      expect(result).toBe('["final"]');
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
