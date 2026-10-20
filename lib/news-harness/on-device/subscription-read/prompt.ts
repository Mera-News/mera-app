// On-device subscription read: how a publication the reader pays for covered a
// story, from its headline and description only (the body is paywalled and
// never fetched). Plain text, or a bare SKIP.
import { asUntrusted } from '../../prompts/untrusted-text';

export const SUBSCRIPTION_READ_SYSTEM = `You say how one news outlet covered a story. You get the headline and a short description from an outlet the reader subscribes to. You have not seen the full article, which is behind a paywall.
Write one or two plain sentences on what this outlet emphasises about the story. Never claim or imply you read the full article. Never add a detail that is not in the text you were given. No preamble, quotation marks or headings.
If the text is too thin to say anything useful, reply with exactly: SKIP`;

export interface SubscriptionReadInput {
  anchorTitle: string | null;
  publicationName: string | null;
  title: string | null;
  description: string | null;
  category: string | null;
  eventType: string | null;
}

export function buildSubscriptionReadPrompt(input: SubscriptionReadInput): { system: string; prompt: string } {
  const field = (label: string, value: string | null) => (value ? [`${label}: ${asUntrusted(value)}`] : []);
  const lines = [
    `The reader is looking at this story: ${input.anchorTitle ? asUntrusted(input.anchorTitle) : '(untitled)'}`,
    '',
    ...field('Their subscribed outlet', input.publicationName),
    ...field('Its headline', input.title),
    ...field('Its description', input.description),
    ...field('Category', input.category),
    ...field('Event type', input.eventType),
  ];
  return { system: SUBSCRIPTION_READ_SYSTEM, prompt: lines.join('\n') };
}
