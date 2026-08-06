// mera-explainer-content.test.ts — CONTENT INVARIANTS for the text the
// `explainMera` chat tool feeds the model.
//
// These are build-failing on purpose. This file's prose is the only thing
// standing between "ask me how that works" and a model answering a privacy
// question from memory, so the two claims Mera must never make, and the
// mechanism it does not publish, are checked mechanically rather than left to a
// reviewer noticing.
//
// The check runs over the RAW FILE TEXT, comments included — this repository is
// published, so a mechanism term sitting in a code comment is a leak just the
// same as one in a template literal.

import { readFileSync } from 'fs';
import { join } from 'path';

import { MERA_EXPLAINER_SECTIONS } from '../mera-explainer-content';
import { MERA_EXPLAINER_TOPIC_IDS } from '@/lib/news-harness/persona-management/persona-agent-core';

const SOURCE_PATH = join(__dirname, '..', 'mera-explainer-content.ts');
const source = readFileSync(SOURCE_PATH, 'utf8');

describe('mera-explainer-content — banned claims', () => {
  // The licence is not OSI-approved. The promo site's own CLAUDE.md forbids the
  // stronger label outright, and it is the single cheapest claim available to
  // this product, which is exactly why it is checked rather than trusted.
  it('never uses the OSI licence label', () => {
    expect(source).not.toMatch(/open[- ]source/i);
  });

  // README.md states plainly that the attestation quote's signature is NOT
  // checked against the hardware vendor, so today's trust anchor is Mera plus
  // the enclave operator, not the silicon. Any wording implying otherwise is a
  // false security claim.
  it('never claims the enclave hardware is checked', () => {
    expect(source).not.toMatch(/attestation[- ]verified/i);
  });
});

describe('mera-explainer-content — pipeline confidentiality', () => {
  // The public surface is exactly: WHICH feeds (the registry repo) and THAT we
  // pre-process them. Not a stage list, not a model, not a matching method, not
  // a threshold, not an expiry window, not the infrastructure.
  const MECHANISM_TERMS =
    /hdbscan|jina|gemini|embedding|vector|cluster|cosine|cld3|bullmq|cloud run|mongo|redis/i;

  it('names no processing mechanism anywhere in the file', () => {
    const hit = source.match(MECHANISM_TERMS);
    expect(hit ? `${hit[0]} @ "${source.slice(Math.max(0, hit.index! - 60), hit.index! + 60)}"` : null)
      .toBeNull();
  });

  it('points at the public feed registry instead', () => {
    expect(MERA_EXPLAINER_SECTIONS.how_news_works).toContain(
      'github.com/Mera-News/mera-news-rss-feeds',
    );
  });
});

describe('mera-explainer-content — shape', () => {
  it('carries exactly the topic ids the tool advertises', () => {
    expect(Object.keys(MERA_EXPLAINER_SECTIONS).sort()).toEqual(
      [...MERA_EXPLAINER_TOPIC_IDS].sort(),
    );
  });

  it('gives every section real substance', () => {
    for (const [id, text] of Object.entries(MERA_EXPLAINER_SECTIONS)) {
      // id in the message so a failure names the thin section, not just a number.
      expect({ id, chars: text.length > 800 }).toEqual({ id, chars: true });
    }
  });

  // The honest passages are the reason this tool is worth shipping at all — a
  // reference document that only says flattering things is marketing, and the
  // model would be right to distrust it.
  it('keeps the known gaps honest', () => {
    const gaps = MERA_EXPLAINER_SECTIONS.known_gaps;
    for (const beat of [
      /cloud is the default/i,
      /reproducible builds/i,
      /which code a server is actually running/i,
      /account deletion/i,
      /unbounded/i,
      /third-party security assessment/i,
    ]) {
      expect(gaps).toMatch(beat);
    }
  });
});
