// On-device topic generation from the fact alone (owner decision: on-device
// has no combination pass, so no other facts and no location line). Written for the phone's small models: no real-world
// examples, which a small model copies into its answer; a short system
// instruction (Gemini Nano wants it under ~150 words); the rules lead the user
// message so a prefix cache keeps them across facts.
import { buildBaseUserPrompt, type RealTopicGenInputs } from '../../persona-management/topic-generation';

export const TOPIC_GEN_SYSTEM = `You suggest news search topics for one fact about a user. Each topic is a search phrase of 1 to 5 words that news articles about the user's life would match. Follow the rules in the message. Reply with JSON only: {"topics": ["..."]}.`;

const TOPIC_GEN_RULES = `Rules
1. Every topic is about the fact's subject. Never add a place, organisation or person the fact does not lead to.
2. Where the fact points:
- The user lives, works or studies in a place: start at that place and widen one step at a time (neighbourhood, city, region, country, then the group of countries it belongs to). Include one topic on the city's public transport and one on the country's public services or rail.
- Someone else is in a place, or the user is only visiting it: stay at that exact place. Cover its local news, safety, weather and transport. No wider region, no visas, no travel advice.
- The fact says where the user comes from and they live somewhere else: only rules that reach citizens abroad (visas, passports, consular services, citizenship, money sent home, tax treaties, voting from abroad). Never that country's own domestic news. If the fact also says where they live now, give about half the topics to that country's rules for immigrants (residence permits, integration, recognition of foreign qualifications).
- The fact is about work, a company, an investment or an interest: no place. Name concrete news in that field, such as rulings, laws, releases, results and deals.
3. How specific:
- A city or a small region may have one general topic: its name followed by "news".
- A country or a group of countries needs a subject: policy, tax, elections, immigration, economy, transport, emergencies, weather, healthcare or energy. Never its name followed by "news".
- A country of over a billion people never gets a general country topic.
4. Never use the words "industry trends", "career development", "awards" or "festivals". Never give two topics about the same thing. Never use a person's name; use their role. Never use a nationality label or a visa code; say "expats", "diaspora" or "overseas citizens".
5. Give at most the number of topics asked for. If the fact gives nothing to search for, reply {"topics": []}.`;

/** The instruction and the message for one fact. `count` is the most topics to ask for. */
export function buildTopicGenPrompt(
  inputs: Pick<RealTopicGenInputs, 'factStatement' | 'excludeTopics'>,
  count: number,
): { system: string; prompt: string } {
  // The fact alone: a location or other facts drawn from the rest of the
  // persona would be a combination.
  const facts = buildBaseUserPrompt({ ...inputs, userLocation: null, otherFacts: [] }, false);
  return { system: TOPIC_GEN_SYSTEM, prompt: `${TOPIC_GEN_RULES}\n\n${facts}\nGenerate ${count} topics.` };
}
