// prewarm.ts — warm the cloud-chat critical path so the first real turn isn't
// gated on cold attestation + JWT fetches, AND so the NEAR model itself is warm.
//
// The first cloud chat turn must (1) fetch the model's TEE attestation from the
// gateway — an UNCACHED NEAR pass-through, the slow hop — (2) mint a JWT, and
// (3) hit a possibly-COLD model (the dominant, multi-second cost the attestation
// + JWT warming alone can't touch). (1) and (2) are cached client-side
// (attestation ~30 min, JWT ~30 s); (3) has no client cache, so we ask BIG_MODEL
// for one greeting question, shown in an empty thread, and only when
// no BIG_MODEL call has left the app for WARM_GAP_MS.
//
// Fire-and-forget and idempotent: repeated calls hit the underlying caches / the
// warmup dedupe, so mounting several chat surfaces in one session costs at most
// one real fetch of each until the caches expire. No-op while chat runs on the
// phone (no gateway hop). Errors are swallowed with a debug log — a failed
// prewarm simply means the first real turn pays the original cost.

import { create } from 'zustand';
import { stripThinkTags } from '../algorithms/think-strip';
import { getJwtToken } from '../auth-client';
import { appLanguageName } from '../chat-tools/agent-device-port';
import { fetchModelPublicKey } from '../e2ee/e2ee-service';
import logger from '../logger';
import { brandRule, fixBrandSpelling, replaceClauseDashes } from '@/lib/mera-harness';
import { chatRunsInCloud } from './chat-cloud';
import { bigModelCalledAt, cloudComplete } from './cloudComplete';
import { BIG_MODEL, SMALL_MODEL } from './constants';

// Unlike attestation/JWT (client-cached), the warm-up hits the model, so it runs
// only when NEAR has gone WARM_GAP_MS without a BIG_MODEL call from this app (any
// chat turn counts, and so does the warm-up itself).
const WARM_GAP_MS = 10 * 60_000;
const GREETING_MAX_CHARS = 60;
// Claims the warm-up between the gap check and cloudComplete stamping the call,
// so concurrent callers don't double-fire.
let warming = false;
// Bumped by dismissMeraGreeting, so a greeting that lands after the user sent
// something is dropped instead of shown in a later empty thread.
let greetingGen = 0;

/** The warm-up's greeting line. Memory only: never persisted, never sent to a model. */
export const useMeraGreeting = create<{ text: string | null }>(() => ({ text: null }));

/** The user sent a message: the greeting has had its moment. */
export function dismissMeraGreeting(): void {
  greetingGen += 1;
  useMeraGreeting.setState({ text: null });
}

/**
 * Kick off the attestation + JWT fetches AND a throwaway model completion for
 * the cloud persona-chat model. Returns immediately (void); all warming runs in
 * the background.
 */
export function prewarmCloudChat(): void {
  // Chat on the phone never touches the gateway: nothing to warm.
  if (!chatRunsInCloud()) {
    logger.debug('[chat-timing] prewarm skipped (on-device)');
    return;
  }

  const startMs = Date.now();
  // THE TWO PRIMARIES ONLY. Fallback attestations are fetched lazily, inside
  // the build for whichever leg actually needs one.
  //
  // Every gateway call now takes a limiter grant, and these are serialised
  // behind it — so each extra prewarm fetch pushes warmModel(), the dominant
  // cold-start cost this file exists for, a further interval out. The old
  // three-fetch shape spent that on BIG, fallback(BIG) and fallback(SMALL)
  // while never warming SMALL_MODEL itself, which is what cloudChatStream
  // defaults to and what every scoring call uses.
  //
  // Cost of going lazy, on the fallback path: a hedge leg that must attest
  // cold pays one interactive grant plus one uncached attestation round trip
  // before it can send. It only runs after 10s of total silence from the
  // primary (HEDGE_DELAY_MS) and exists to rescue a stall, not to shave
  // latency, so a second or two at the front of the rescue is the right trade
  // for two fewer requests on every launch.
  void Promise.allSettled([
    fetchModelPublicKey(BIG_MODEL, 'interactive'),
    fetchModelPublicKey(SMALL_MODEL, 'interactive'),
    getJwtToken(),
  ]).then(
    (results) => {
      const failed = results.filter(
        (r): r is PromiseRejectedResult => r.status === 'rejected',
      );
      logger.debug('[chat-timing] prewarm settled', {
        ms: Date.now() - startMs,
        failed: failed.length,
      });
      for (const r of failed) {
        logger.debug('[chat-timing] prewarm task failed (swallowed)', {
          error: String(r.reason),
        });
      }
    },
  );

  // Warm the MODEL itself (fire-and-forget, silent), only after WARM_GAP_MS of
  // model silence so repeated surface mounts don't each pay for an inference.
  void warmModel();
}

/** Morning, afternoon or evening by the device's local clock; only the word leaves the device. */
function partOfDay(): string {
  const hour = new Date().getHours();
  return hour >= 5 && hour < 12 ? 'morning' : hour >= 12 && hour < 18 ? 'afternoon' : 'evening';
}

/** The model's reply when it is one short question (the asked-for greeting), else null. */
function greetingLine(raw: string, lang: string): string | null {
  const line = fixBrandSpelling(replaceClauseDashes(stripThinkTags(raw)), lang, '').replace(/\s+/g, ' ').trim()
    // The prompt quotes the sentence, so a model often echoes the quotes back.
    .replace(/^["'“”„«»「『]+|["'“”«»」』]+$/gu, '').trim();
  // One sentence ending in a question mark (Latin, CJK or Arabic): a cut, a second sentence or chatter shows nothing.
  // shortcut: a Thai line with no final mark is dropped too; return finish_reason from cloudComplete if that shows up.
  return line.length <= GREETING_MAX_CHARS && /^[^.!?。！？।؟]+[?？؟]$/u.test(line) ? line : null;
}

/**
 * Ask BIG_MODEL for "Good <part of day>, how can I help you?" in the app language
 * so the NEAR model is loaded before the user's first real turn, and show that
 * line while the thread is still empty.
 * The request carries no user data: the part of day and the app language only.
 * Fully silent: no Sentry, no toast; a failure just means no greeting and a
 * cold first turn. Only runs when a JWT is obtainable (an unauthenticated
 * completion would just 401-storm).
 */
async function warmModel(): Promise<void> {
  if (warming || Date.now() - bigModelCalledAt() < WARM_GAP_MS) return;
  warming = true;
  const gen = greetingGen;
  useMeraGreeting.setState({ text: null });
  try {
    const token = await getJwtToken();
    // No auth yet: leave the gap unclaimed so a later call (post-login) can warm.
    if (!token) return;
    const lang = appLanguageName();
    const part = partOfDay();
    const reply = await cloudComplete({
      systemPrompt:
        `You are Mera, the user's news assistant. Translate this greeting for the ${part} into ${lang}: ` +
        `"Good ${part}, how can I help you?" Reply with that one translated sentence only, ` +
        'ending in a question mark. Nothing before or after it. No dashes, no emoji.' +
        (brandRule(lang) && `\n${brandRule(lang)}`),
      prompt: 'Greet me.',
      model: BIG_MODEL,
      maxTokens: 64,
      temperature: 0.1,
      purpose: 'chat',
    }, { lane: 'interactive' });
    const text = greetingLine(reply, lang);
    if (text && gen === greetingGen) useMeraGreeting.setState({ text });
    logger.debug('[chat-timing] model warmup completion done');
  } catch (err) {
    // Best-effort only — swallow everything (no Sentry, no toast).
    logger.debug('[chat-timing] model warmup failed (swallowed)', {
      error: String(err),
    });
  } finally {
    warming = false;
  }
}
