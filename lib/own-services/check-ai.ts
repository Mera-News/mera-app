import type { AiCheckStatus } from './own-ai-state';

const TIMEOUT_MS = 15_000;

// Direct fetch with no cookie or Mera header, so the check sends nothing about the person.
export async function checkOwnAi(args: { baseUrl: string; model: string; key: string | null }): Promise<AiCheckStatus> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    // shortcut: redirect 'manual' on expo/fetch is proven only on a device; revisit if a device follows redirects
    const res = await fetch(`${args.baseUrl}/chat/completions`, {
      method: 'POST',
      redirect: 'manual',
      credentials: 'omit',
      signal: controller.signal,
      headers: { 'content-type': 'application/json', ...(args.key ? { authorization: `Bearer ${args.key}` } : {}) },
      body: JSON.stringify({ model: args.model, messages: [{ role: 'user', content: 'Reply with OK.' }], max_tokens: 1, stream: false }),
    });
    const s = res.status;
    if (res.type === 'opaqueredirect' || (s >= 300 && s < 400)) return 'redirect';
    if (s === 401 || s === 403) return 'refused';
    if (s === 429) return 'busy';
    if (s >= 500) return 'failing';
    const text = await res.text().catch(() => '');
    if (s === 404 || s === 400) {
      let code: unknown;
      try { code = JSON.parse(text)?.error?.code; } catch { /* a body that is not JSON has no code */ }
      return code === 'model_not_found' || /model/i.test(text) ? 'no-model' : 'not-openai';
    }
    if (s >= 200 && s < 300) {
      try { return Array.isArray(JSON.parse(text)?.choices) ? 'connected' : 'not-openai'; } catch { return 'not-openai'; }
    }
    return 'not-openai';
  } catch {
    return 'unreachable';
  } finally {
    clearTimeout(timer);
  }
}
