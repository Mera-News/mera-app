// On-device subscription read: how a publication the reader pays for covered a
// story, from its headline and description only (the body is paywalled and
// never fetched). Plain text, or a bare SKIP.
import { asUntrusted } from '../../prompts/untrusted-text';
import { DEVICE_BASE_SLOTS } from '../../../harnesses/slots.generated';

export const SUBSCRIPTION_READ_SYSTEM = DEVICE_BASE_SLOTS["subscription-read/subscription-read-system"];

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
