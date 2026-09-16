// harness-local - the GATEWAY lane.
//
// Posts through mera-inference-gateway with the app's real E2EE envelope,
// instead of straight to NEAR. Same plaintext reaches the model either way, so
// this is not a second way to measure prompt QUALITY; it is the arm that proves
// the transport the app actually ships, and it is the only lane that can
// measure gateway-side latency, the JWT gate and the hedge.
//
// WHY THE CRYPTO IS IMPORTED AND NOT REIMPLEMENTED. An envelope drift surfaces
// as NEAR's own "400 ... Decryption failed", which reads as a model or gateway
// fault and burns hours. lib/e2ee/e2ee-crypto.ts is the app's own primitives,
// RN-free by construction, so the harness and the shipped decrypt sites cannot
// disagree about what a valid envelope is.
//
// NOT USABLE WITH EVERY MODEL. The E2EE path keys on
// model_attestations[0].signing_public_key, which only NEAR's self-hosted TEE
// tier returns (owned_by "nearai"). An attested-3p id answers 200 with
// e2e_pubkey and no signing key, and the parser throws before a request is
// sent. Probe the attestation route before adopting an id.
//
// Node-only: never imported by the app bundle.

import { ed25519 } from '@noble/curves/ed25519.js';
import { secp256k1 } from '@noble/curves/secp256k1.js';

import {
  algoForKeyBytes,
  buildE2EEHeaders,
  bytesToHex,
  decryptContent,
  encryptContent,
  type E2EEContext,
  type SigningAlgo,
} from '../../lib/e2ee/e2ee-crypto';
import type { NearResult, NearUsage } from '../lib/near-call';
import { SpendLimitError } from '../lib/near-call';

export interface GatewayConfig {
  inferenceEndpoint: string;
  /** Minted from a staging session; see adapters/auth.ts mintJwt. */
  jwt: string;
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 130_000;

export interface ModelAttestation {
  publicKey: string;
  algo: SigningAlgo;
}

/**
 * Fetches the model's attested public key through the gateway. The route is
 * JWT-guarded, so a tokenless call is a guaranteed 401 and is not attempted.
 */
export async function fetchModelKey(cfg: GatewayConfig, model: string): Promise<ModelAttestation> {
  const url = `${cfg.inferenceEndpoint}/api/attestation/report?model=${encodeURIComponent(model)}&signing_algo=ed25519`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${cfg.jwt}` } });
  if (!res.ok) {
    throw new Error(
      `harness-local: gateway attestation failed: ${res.status} ${res.statusText}. ` +
        (res.status === 401 || res.status === 403
          ? 'The JWT was refused; mint a fresh one.'
          : `Body: ${(await res.text().catch(() => '')).slice(0, 200)}`),
    );
  }
  const data = (await res.json()) as {
    model_attestations?: { signing_public_key?: string }[];
  };
  const key = data.model_attestations?.[0]?.signing_public_key;
  if (!key) {
    throw new Error(
      `harness-local: ${model} returned no model_attestations[0].signing_public_key. ` +
        'That is the attested-3p tier, which the E2EE path cannot serve. Use a self-hosted ' +
        '(owned_by "nearai") model.',
    );
  }
  return { publicKey: key, algo: algoForKeyBytes(key.length / 2) };
}

/** Mints a client keypair on the model key's own curve and builds the headers. */
export function prepareContext(att: ModelAttestation): E2EEContext {
  let privateKey: Uint8Array;
  let clientPubKeyHex: string;
  if (att.algo === 'ecdsa') {
    // secp256k1 carries the FULL 65-byte uncompressed point in the header,
    // while the MODEL key is the 64-byte raw x||y. That asymmetry is NEAR's,
    // not ours, and getting it wrong fails as a decrypt error much later.
    privateKey = secp256k1.utils.randomSecretKey();
    clientPubKeyHex = bytesToHex(secp256k1.getPublicKey(privateKey, false));
  } else {
    privateKey = ed25519.utils.randomSecretKey();
    clientPubKeyHex = bytesToHex(ed25519.getPublicKey(privateKey));
  }
  return {
    modelPubKeyHex: att.publicKey,
    privateKey,
    clientPubKeyHex,
    algo: att.algo,
    headers: buildE2EEHeaders(att.algo, clientPubKeyHex, att.publicKey),
  };
}

export interface GatewayRequest {
  model: string;
  messages: { role: string; content: string }[];
  temperature?: number;
  maxTokens?: number;
  enableThinking: boolean;
  tools?: unknown[];
  toolChoice?: 'auto' | 'none';
}

interface RawChoice {
  message?: { content?: string | null; reasoning_content?: string | null; tool_calls?: { function?: { name?: string; arguments?: string } }[] };
  finish_reason?: string;
}

/**
 * One encrypted completion through the gateway. Returns the same shape as the
 * direct lane so a runner can record either without branching, EXCEPT that a
 * decrypt failure is surfaced as an error string rather than thrown: on a
 * measurement run it is a result about the transport, which is the thing this
 * lane exists to measure.
 */
export async function postGatewayCompletion(
  cfg: GatewayConfig,
  ctx: E2EEContext,
  req: GatewayRequest,
): Promise<NearResult> {
  const started = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), cfg.timeoutMs ?? DEFAULT_TIMEOUT_MS);

  const fail = (error: string): NearResult => ({
    content: '', toolCalls: [], finishReason: '-', truncated: false,
    usage: null, modelSent: null, latencyMs: Date.now() - started, error,
  });

  try {
    // Every message content is encrypted toward the model key. The roles and
    // the parameters travel in clear, exactly as the app sends them.
    const encrypted = req.messages.map((m) => ({
      role: m.role,
      content: m.content.length > 0 ? encryptContent(m.content, ctx, cfg.inferenceEndpoint) : m.content,
    }));

    const body: Record<string, unknown> = {
      model: req.model,
      messages: encrypted,
      stream: false,
      chat_template_kwargs: { enable_thinking: req.enableThinking },
    };
    if (req.temperature !== undefined) body.temperature = req.temperature;
    if (req.maxTokens !== undefined) body.max_tokens = req.maxTokens;
    if (req.tools) {
      body.tools = req.tools;
      body.tool_choice = req.toolChoice ?? 'auto';
    }

    const res = await fetch(`${cfg.inferenceEndpoint}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${cfg.jwt}`,
        ...ctx.headers,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      if (res.status === 402) {
        throw new SpendLimitError(
          `gateway refused with 402: ${text.slice(0, 200)}`,
          /Spent:\s*\$?([0-9.]+)/i.exec(text)?.[1] ?? null,
          /Limit:\s*\$?([0-9.]+)/i.exec(text)?.[1] ?? null,
          text,
        );
      }
      return fail(`HTTP ${res.status}: ${text.slice(0, 300)}`);
    }

    const json = (await res.json()) as {
      model?: string;
      choices?: RawChoice[];
      usage?: { prompt_tokens?: number; completion_tokens?: number; reasoning_tokens?: number; prompt_tokens_details?: { cached_tokens?: number } | null };
    };
    const choice = json.choices?.[0];
    const raw = choice?.message?.content || choice?.message?.reasoning_content || '';

    let content = '';
    if (raw.length > 0) {
      try {
        content = decryptContent(raw, ctx.privateKey, ctx.algo, cfg.inferenceEndpoint);
      } catch (err) {
        // Recorded, not thrown. A decrypt failure IS the measurement here.
        return fail(`decrypt failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    const usage: NearUsage | null = json.usage
      ? {
          promptTokens: json.usage.prompt_tokens ?? 0,
          completionTokens: json.usage.completion_tokens ?? 0,
          cachedTokens: json.usage.prompt_tokens_details?.cached_tokens ?? 0,
          reasoningTokens: json.usage.reasoning_tokens ?? 0,
        }
      : null;

    const finishReason = choice?.finish_reason ?? '-';
    return {
      content,
      // Tool arguments come back encrypted too; decrypting them is only worth
      // doing once a runner actually sends tools through this lane.
      toolCalls: (choice?.message?.tool_calls ?? []).map((t) => ({
        name: t.function?.name ?? '?',
        argumentsRaw: t.function?.arguments ?? '',
      })),
      finishReason,
      truncated: finishReason === 'length',
      usage,
      modelSent: json.model ?? null,
      latencyMs: Date.now() - started,
      error: null,
    };
  } catch (err) {
    if (err instanceof SpendLimitError) throw err;
    return fail(err instanceof Error ? `${err.name}: ${err.message}` : String(err));
  } finally {
    clearTimeout(timer);
  }
}
