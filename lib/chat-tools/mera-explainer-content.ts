// mera-explainer-content — the reference text the `explainMera` chat tool returns.
//
// WHY THIS FILE EXISTS. The onboarding intro invites the user to "ask me how
// that works". Without a sourced answer the model answers a privacy question
// from memory, which is the one outcome that invitation must not produce. Every
// paragraph below is copied or adapted from a canonical source:
//
//   mera-promo-website/lib/i18n/dictionaries/en.json      (faq, solution, innovations)
//   mera-promo-website/public/assets/privacy-policy.md    (2, 7, 10, 11)
//   mera-app/README.md
//   mera-app/lib/locales/en.json                          (configPanel.privacy*, meraProtocol.*)
//
// The whitepaper PDF is deliberately NOT a source: it is stale on several
// material points and uses a licence label this product does not claim.
//
// ENGLISH ONLY. This text is model input, not UI. The persona system prompt
// already forces the reply into the user's app language, so a 20-locale copy of
// this file would cost 20x the bytes and buy nothing.
//
// LOADED LAZILY. `handleExplainMera` reaches this module through require() at
// call time so ~15KB of prose stays out of app startup evaluation. Do not add a
// top-level import of this file anywhere.
//
// ── THREE HARD INVARIANTS, ENFORCED BY A BUILD-FAILING TEST ──
// (see lib/chat-tools/__tests__/mera-explainer-content.test.ts, which regexes the
//  RAW FILE TEXT — comments included, because this repository is published)
//
// 1. The licence label. Mera's licence is not OSI-approved; the stronger,
//    freer-sounding label has a specific meaning and Mera does not meet it, so
//    that label appears nowhere — not in prose, not in a comment.
// 2. No claim that the enclave platform is FULLY checked. The app now verifies
//    the attestation quote's signature chain to a pinned Intel root and that
//    the encryption key is committed inside the quote — but it does NOT check
//    the platform's patch level (TCB currency), does not compare measurements
//    against published expected values, does not verify GPU attestation, and
//    does not refuse to continue when a check fails. So "verified" may be
//    written about the quote chain and the key binding, and must never be
//    written unqualified about the hardware or the platform.
// 3. No decoy / noise-injection claim. Mera ships no decoy topics and no
//    noise-injection setting: nothing generates, sends or discards them, and
//    no control exists to switch one on. An earlier version of this file
//    described such a setting, which is why the test now bans any affirmative
//    mention of one.
//    The layer IS being built (Mera Protocol Rules 2/3/5 are marked `Planned`
//    in lib/mera-protocol-toolkit/mera_protocol.md). The ban is on presenting
//    it as a protection the user has NOW, not on the feature existing one day.
//    When it ships, lift the ban here and in the test together.
//
// ── CONFIDENTIALITY: how news is gathered and prepared is NOT public ──
//
// `how_news_works` stops at two facts: WHICH feeds (the public registry) and
// THAT we pre-process them before the device does the final scoring. Nothing in
// this file may name a processing stage, a model, a grouping or matching method,
// a similarity threshold, an expiry window, a queue, a datastore, or the
// infrastructure any of it runs on. The test above fails the build on the known
// terms; the rule is broader than the regex, so hold the line by intent, not by
// what the pattern happens to catch.

import type { MeraExplainerTopicId } from '@/lib/news-harness/persona-management/persona-agent-core';

export const MERA_EXPLAINER_SECTIONS: Readonly<Record<MeraExplainerTopicId, string>> = Object.freeze({
  // ---------------------------------------------------------------------------
  what_is_mera: `Mera is an impact-first personal news assistant. There is no infinite feed and no engagement farming. Mera watches hundreds of publications worldwide and surfaces only what genuinely affects you, so it succeeds when you spend LESS time reading news, not more. It is built to give back the 60 to 90 minutes a day most people lose filtering the news themselves.

Every story Mera shows carries a plain-language "Why this matters to you" explanation, written against what Mera knows about your life: a policy change in your country, an emergency near people you love, a regulation shift in your industry. That is the difference from a trending list. Trending tells you what is loud. Mera tells you what reaches you.

Mera does not summarise or rewrite articles. You get the headline and Mera's reasoning for why it matters; the reading itself happens at the original publisher, through a direct link. That is deliberate. Rather than replacing journalism, Mera routes attention and traffic back to the newsrooms that produced it, and the readers who arrive came because the story genuinely mattered to them.

You control the interruptions. You can set up to 24 alert opportunities a day, at times that suit you. Life-safety emergencies are the single exception that always breaks through your cap.

Mera runs on iOS and Android, worldwide. The app interface is available in 20 languages, and news is gathered from sources in many more, so the language a story was written in never limits what reaches you.

Reading a story in another language works in two ways. Your phone can translate on its own: Android handles 59 languages, downloading each model the first time it is needed, and an iPhone handles 20 today and 26 on iOS 27 and later, because Apple ships translation languages with the operating system. Independently of that, every article page offers to open the publisher through Google Translate, which covers more than 200 languages on both platforms with nothing to download. Mera itself never rewrites the article; the translating is done by the phone or by Google.

Mera is built in the Netherlands, under the EU's GDPR, by a very small team. It is subscription-only: there are no ads, and your data is never sold. You are the customer, not the product.`,

  // ---------------------------------------------------------------------------
  privacy_what_leaves_device: `Your profile never leaves your device. The personal facts you tell Mera, the profile built from them, your reading history, which articles you opened, which you dismissed, and everything you have said in this chat window are stored locally and are not sent to Mera's servers.

What IS sent, each time you ask for news, is a short list of broad topic phrases: things like "Amsterdam housing policy" or "EU technology regulation". Optionally a country goes with them, so local reporting can be found. That is the entire payload. No profile. No personal facts. No reading history. No user ID, no session, nothing that says the request came from you. This design is what Mera calls the Mera Protocol, and it is always on.

The gap between a fact and a topic is the whole point. "Lives in Jordaan, Amsterdam" stays on your phone; "Amsterdam local news" is what travels. Your device turns one into the other, and only the second half is ever visible to anyone else.

Two honest caveats. First, chat with Mera is a separate thing from the topic payload: on the cloud path your messages ARE sent for the AI to process, encrypted, and discarded afterwards. Ask about encryption for how that works. Second, switching devices or logging out means rebuilding your profile from scratch, precisely because there is no server-side copy to restore.`,

  // ---------------------------------------------------------------------------
  privacy_what_we_store: `Tied to your account, Mera's servers hold a deliberately short list: the email address you sign in with, your sign-in session records, your subscription status and entitlement, a per-day count of how many articles were analysed for your account (this is how a plan's daily limit is enforced), and the billing records the app stores send when your subscription changes. Billing records are kept for 7 years where Dutch law requires it; the rest lives until you delete your account.

One exception, stated explicitly: if the in-app assistant's safety guardrail blocks you and you choose to submit a request to be unblocked, the transcript you elect to attach is sent and stored so a person can review the appeal. It happens only on your own action, never during ordinary use.

The topic phrases you send ARE stored, and it matters exactly how. They go into a shared cache keyed by the topic text itself: one entry per distinct phrase, drawn on by every reader, carrying no user identifier and no owner field. Any phrase nobody has requested for 14 days is deleted. No database anywhere associates a user with a topic. That is not a policy promise about a table Mera chooses not to query; the linking record is not created in the first place, so it cannot be produced in a breach or under legal compulsion.

Not stored on Mera's servers at all: your personal facts (beyond the sign-in email), interest profiles, reading history, article-open or dismissal history, which articles became notifications, the reasoning behind them, AI inputs and outputs, location data, contacts, or any browsing outside Mera.

Two retention windows are still unbounded and are being worked on: submitted unblock transcripts, and per-day analysis counts. Request timestamps are kept 90 days, crash logs 30.`,

  // ---------------------------------------------------------------------------
  encryption_and_inference: `Relevance scoring is real AI work, and it runs in one of two places, your choice, subject to what your phone supports.

On-device: if your device can run the model locally, everything happens offline on your phone and nothing about the analysis leaves it at all. This needs a capable device and a model download of roughly 2.7GB.

Cloud: otherwise the work runs inside a trusted execution environment, a hardware-isolated enclave the operator cannot look into. Your app fetches the enclave's attestation report, takes the public key it publishes, and encrypts the request to that key end to end (X25519 key exchange, XChaCha20-Poly1305 for the payload). The request is unreadable in transit and unreadable to Mera. It is decrypted only inside the enclave, the result comes back encrypted to your device, and everything is wiped once the computation finishes. Nothing from it is retained.

Now the part Mera would rather you heard from us. The app does check the attestation quote: it verifies the quote's signature chain up to Intel's own root certificate, which is built into the app, and it checks that the key your request is encrypted to is the key committed inside that quote. That last check matters most, because a genuine quote served next to somebody else's key would otherwise look fine. You can run these checks yourself in Settings, under Mera Protocol.\n\nWhat is still missing: Mera does not check whether the platform's firmware is up to date, does not compare the enclave's measurements against published expected values, does not verify the GPU's separate attestation, and does not yet refuse to continue when a check fails - a failure is shown to you, not enforced. So this path is not hardware-proven, Mera does not describe it that way, and neither should anyone quoting Mera.

Be clear about which of the two defaults: cloud is the default, and on-device is something you switch on. Both are reachable from the Mera Protocol section of your settings, along with which mode is currently active.`,

  // ---------------------------------------------------------------------------
  how_news_works: `Mera reads the publicly published RSS and Atom feeds of news organisations. The full list is not a secret: it lives in a public feed registry at github.com/Mera-News/mera-news-rss-feeds, where anyone can inspect exactly which publications Mera reads, add one, or argue with a choice.

Those feeds are pre-processed on Mera's side so they are ready to be consumed, and the final step, deciding what actually matters to YOU, happens on your device, against a profile that never left it.

One behaviour worth knowing, because it changes what reaches you: articles are matched across languages. A report published in a local language and an English report about the same event are recognised as the same story and grouped together. That means the language a story was written in never limits whether it reaches you, and you are not shown the same event five times because five newsrooms covered it.

That is the honest extent of what Mera publishes about this. How the feeds are gathered and prepared is not something Mera documents publicly, and if you push for detail, the answer will not get more specific, because there isn't a fuller version being withheld from you personally. What IS public, and checkable, is the part that matters for judging Mera's coverage: which publications are read. That is the registry, and it is open to read right now.

Mera does not write, rewrite, or summarise the journalism itself. Headlines and Mera's own reasoning are what you see in the app; the article is read at the publisher.`,

  // ---------------------------------------------------------------------------
  source_available: `Mera's app is source-available. Its full source is published so anyone can read it, compile it, run it, and audit it for security. The licence, the Mera Source-Available License, grants those rights for study, security review, and evaluation, and does not grant production or commercial use.

Mera is deliberate about that wording and does not reach for the stronger, freer-sounding label that gets used loosely across the industry. That label has a specific meaning: an OSI-approved licence, carrying the freedom to use the software for anything and to pass it on. Mera's licence does not meet it. Claiming it anyway would be the cheapest possible claim to make, which is exactly why Mera does not make it.

The honest gap: the backend is not published yet. Today you can verify what the app SENDS, by reading its source or by watching your own network traffic (Mera publishes guides for doing that). You cannot yet read what happens next. The target for closing this is before September 2026, and it is not a matter of flipping a repository to public. The code that handles your data and the code that runs the news pipeline currently share a codebase, and separating them properly is most of the work.

What is being built is one new repository with four deployable parts, all source-available: the API the app queries, the authentication service handling email sign-in and sessions, the encrypted inference relay (already published), and a background worker for notifications. That service becomes the only thing the app talks to, and everything that knows who you are moves into it. The news side stays closed and becomes a pure article service that receives topic phrases with no identifier attached at all, on separate databases with separate credentials.

None of that is finished. It is described in the future tense on purpose.`,

  // ---------------------------------------------------------------------------
  plans_and_limits: `There are three plans, Starter, Individual and Professional, and they differ in exactly one thing: how many candidate articles can be analysed for you per day. Starter covers up to 250 candidate articles a day, Individual up to 1,000, and Professional up to 10,000. The plans screen in the app is the authority on those figures, because it reads them from the store rather than from anything written down here.

Prices are deliberately not quoted here. They are set per country and per currency by the App Store and Google Play, and the exact figure for where you are is shown on the plans screen in the app, which reads it from the store rather than from anything written down in advance. Any number quoted from memory would eventually be the wrong one for somebody.

Every new account gets its first two weeks free, on the Starter capacity. That is granted by Mera itself, not by the App Store or Google Play, so it needs no payment details, no card, and no subscription to start it — nothing is charged and nothing auto-renews. When the two weeks end, nothing is taken away from what is already on your device; new AI analysis is what stops until you choose a plan.

Every plan includes the complete Mera experience. There is no feature held back behind a higher tier: same personalisation, same alerts, same explanations, same languages. Only the daily analysis capacity changes.

"Article analysis capacity" means the number of candidate articles an AI can examine for you in a day to decide whether, and why, each one actually matters to you. It is not the number of articles you will be shown; the great majority of candidates are analysed and then discarded as not relevant to you. That analysis is the expensive part, it is what your subscription pays for, and the per-day count of it is one of the few things Mera's servers hold against your account.

Separately from the plan, you control interruptions: up to 24 alert opportunities per day at times you choose, with life-safety emergencies as the one exception that always breaks through.

Subscriptions are managed through the App Store or Google Play, and there is a manage-subscription screen inside the app. You can cancel at any time. There are no ads on any plan, and your data is not sold on any plan; being subscription-funded is what makes that possible.`,

  // ---------------------------------------------------------------------------
  known_gaps: `Mera would rather you heard these from Mera than found them yourself. All of these are true right now.

Cloud is the default, not on-device. Running the AI on your own phone is something you turn on, and Mera's own writing can leave the opposite impression. Said plainly: unless you switched it, your relevance scoring is running in the enclave, not on your handset.

The app verifies the enclave's attestation quote against Intel's root certificate and confirms the encryption key is committed inside that quote, but it does not check the platform's firmware level or the GPU's attestation, and it does not yet refuse to continue when a check fails.

The backend is not published yet, so what happens to your topic phrases is documented but not readable. Target: before September 2026.

There are no reproducible builds and no signed release hashes. You can read Mera's source, and you cannot yet prove that the app installed on your phone was built from it.

Even once the backend is public, published source can never prove WHICH code a server is actually running. Nobody's can, Signal's included, and Mera would rather say so than imply otherwise. A transparency report is planned so that at least Mera's conduct under legal requests is on the record.

Account deletion does not yet remove every trace across every system in a single pass.

Some retention windows are still unbounded, specifically submitted unblock transcripts and per-day usage counts.

There has been no independent third-party security assessment yet.

Hardening against prompt injection in AI-processed content is ongoing.

Mera is built by a very small team. These gaps are real, they are published rather than waited on until someone catches them, and the honest ask is that you trust Mera to close them, not that you believe they are already closed.`,
});
