// Pins a sha256 per prompt the app sends, for every harness folder that serves it, against the
// checked-in prompt-hashes.json. The Qwen prompt text is frozen: moving a prompt between files must
// leave every hash here unchanged. Builders run over a grid of their flags, so every branch is
// pinned, not just the default. A deliberate prompt change rewrites the snapshot on purpose:
//   UPDATE_PROMPT_HASHES=1 npx jest --watchman=false --testPathPatterns prompt-hashes
import { createHash } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { HARNESS_FILES, loadHarness } from '@/lib/harnesses';
import { ON_DEVICE_HARNESS, resolveSlots } from '@/lib/harnesses/slots';
import { buildRouterPrompt, factRemovedPrompt, loadSkill } from '@/lib/mera-harness';
import { meraIdentity, meraRouteIdentity } from '@/lib/mera-harness/core/identity';
import { brandRule, voiceRules } from '@/lib/mera-harness/core/router-prompt';
import { PERSONA_SKILLS, PERSONA_SKILL_IDS } from '@/lib/mera-harness/skills/index.generated';
import * as prompts from '@/lib/news-harness/prompts/prompts';
import { buildBaseUserPrompt } from '@/lib/news-harness/persona-management/topic-generation';
import {
  buildArticleFeedbackSystemPrompt,
  getArticleFeedbackToolDefinitions,
} from '@/lib/news-harness/article-feedback/agent-core';
import {
  buildFollowStoryContext,
  buildFollowStorySystemPrompt,
  getFollowStoryToolDefinitions,
} from '@/lib/news-harness/follow-story';
import type { KevMessage, KevPorts } from '@/lib/news-harness/on-device/kev';

const SNAPSHOT = path.join(__dirname, 'prompt-hashes.json');
const NONCE = 'f1x3dn0nce';
const NOW = Date.UTC(2026, 10, 10, 12);
const BASES = ['cloud-base', 'device-base'] as const;
type Base = (typeof BASES)[number];
type Producer = () => unknown;

const sha = (v: unknown) =>
  createHash('sha256').update(typeof v === 'string' ? v : JSON.stringify(v)).digest('hex');
const bools = [false, true] as const;
const langs = [undefined, 'Hindi'] as const;
const flag = (name: string, on: boolean) => (on ? name : `no-${name}`);

// --- Cloud: today's cloud prompt modules ------------------------------------------------------

/** Every exported prompt string of the article and persona prompt modules. */
const CLOUD_CONSTANTS = [
  'CLOUD_FACT_COMBO_TOPIC_GENERATION_SYSTEM_PROMPT', 'CLOUD_FEED_VERIFIER_SYSTEM_PROMPT',
  'CLOUD_HEADLINE_REASON_SYSTEM_PROMPT', 'CLOUD_HEADLINE_REASON_SYSTEM_PROMPT_PRE_GEO',
  'CLOUD_HEADLINE_REASON_SYSTEM_PROMPT_RESCORE', 'CLOUD_HEADLINE_REASON_SYSTEM_PROMPT_V1',
  'CLOUD_HEADLINE_RELEVANCE_SYSTEM_PROMPT', 'CLOUD_HEADLINE_RELEVANCE_SYSTEM_PROMPT_PRE_GEO',
  'CLOUD_REASON_SYSTEM_PROMPT', 'CLOUD_REASON_SYSTEM_PROMPT_PRE_GEO', 'CLOUD_REASON_SYSTEM_PROMPT_RESCORE',
  'CLOUD_REASON_SYSTEM_PROMPT_V1', 'CLOUD_RELEVANCE_SYSTEM_PROMPT', 'CLOUD_RELEVANCE_SYSTEM_PROMPT_PRE_GEO',
  'CLOUD_TOPIC_GENERATION_SYSTEM_PROMPT', 'CLOUD_TOPIC_GEN_RULES_SNIPPET', 'CLOUD_V3_NOTE_SYSTEM_PROMPT',
  'COMBO_PASS_TOPIC_SYSTEM_PROMPT', 'LOCAL_FACT_COMBO_TOPIC_GENERATION_SYSTEM_PROMPT',
  'LOCAL_NOISE_GENERATION_SYSTEM_PROMPT', 'LOCAL_REASON_SYSTEM_PROMPT', 'LOCAL_RELEVANCE_SYSTEM_PROMPT',
  'LOCAL_TOPIC_GENERATION_SYSTEM_PROMPT', 'LOCAL_TOPIC_GEN_RULES_SNIPPET', 'NOISE_GENERATION_SYSTEM_PROMPT',
  'RULE_NAME_BAN', 'TOPIC_GENERATION_SYSTEM_PROMPT', 'TOPIC_SANITY_SYSTEM_PROMPT',
] as const;

const ARTICLE = {
  title: 'Rail strike halts trains across Utrecht',
  description: 'Unions called a 24-hour strike over pay; NS cancelled most services.',
  country: 'NLD',
  relatedFacts: ['Lives in Utrecht, Netherlands, Europe (news from: Utrecht)', 'Commutes by train'],
};
const USER_CONTEXT = '[User facts] Lives in Utrecht, Netherlands, Europe. Works as a nurse.';

function cloudProducers(): Record<string, Producer> {
  const p: Record<string, Producer> = {};
  for (const name of CLOUD_CONSTANTS) p[`const:${name}`] = () => (prompts as Record<string, unknown>)[name];

  for (const surface of ['ONBOARDING', 'CONFIG'] as const)
    for (const mode of ['CLOUD', 'LOCAL'] as const)
      for (const includeToolFormat of bools)
        for (const languageName of langs)
          for (const filterTools of ['full', 'compact', 'off'] as const)
            for (const deepMode of bools)
              for (const canCalibrate of bools)
                for (const webSearch of bools)
                  p[`personaStatic:${[surface, mode, flag('tools', includeToolFormat), languageName ?? 'auto', filterTools,
                    flag('deep', deepMode), flag('calibrate', canCalibrate), flag('web', webSearch)].join('/')}`] = () =>
                    prompts.buildPersonaUpdateStaticPrompt({
                      surface, mode, includeToolFormat, languageName, filterTools, deepMode, canCalibrate, webSearch,
                    });
  for (const surface of ['ONBOARDING', 'CONFIG'] as const)
    for (const filterTools of ['full', 'compact', 'off'] as const)
      for (const canCalibrate of bools) {
        const k = [surface, filterTools, flag('calibrate', canCalibrate)].join('/');
        p[`personaTools:${k}`] = () => prompts.buildToolDefinitions(surface, filterTools, canCalibrate);
        p[`personaToolFormat:${k}`] = () => prompts.buildToolFormatSection(surface, filterTools, canCalibrate);
      }
  p['personaContext:minimal'] = () => prompts.buildPersonaUpdateContext({ knownFactsList: '- [f1] Lives in Utrecht' });
  p['personaContext:full'] = () =>
    prompts.buildPersonaUpdateContext({
      knownFactsList: '- [f1] Lives in Utrecht',
      filtersList: '- [s1] "celebrity"',
      pendingProposal: 'Add fact "Works as a nurse"',
      topicPlanNotesList: '- Saved topics for f1',
    });

  p['topicGenSystem:factOnly'] = () => prompts.buildTopicGenSystemPrompt('factOnly');
  p['topicGenSystem:combo'] = () => prompts.buildTopicGenSystemPrompt('combo');
  p['topicGenUser:fact-only'] = () =>
    buildBaseUserPrompt({ factStatement: 'Works as a nurse', userLocation: null, otherFacts: [], excludeTopics: [] }, false);
  p['topicGenUser:full'] = () =>
    buildBaseUserPrompt(
      {
        factStatement: 'Works as a nurse',
        userLocation: 'Lives in Utrecht, Netherlands',
        otherFacts: ['Commutes by train'],
        excludeTopics: ['Dutch nurse pay'],
        factPlace: 'Utrecht, Netherlands',
      },
      true,
    );
  p['comboPassUser:plain'] = () => prompts.buildComboPassUserMessage('Works as a nurse', ['Lives in Utrecht']);
  p['comboPassUser:places'] = () =>
    prompts.buildComboPassUserMessage('Works as a nurse', ['Lives in Utrecht', 'Commutes by train'], 3, 'Utrecht');

  for (const v3 of bools)
    p[`scoringUser:${flag('v3', v3)}`] = () =>
      prompts.buildBatchScoringUserMessage({ userContext: USER_CONTEXT, articles: [ARTICLE, { title: 'T', description: 'D' }], v3, nonce: NONCE });
  p['verifierUser'] = () =>
    prompts.buildFeedVerifierUserMessage({ userContext: USER_CONTEXT, articles: [ARTICLE], nonce: NONCE });
  const reasonParams = {
    userContext: USER_CONTEXT,
    articleTitle: ARTICLE.title,
    articleDescription: ARTICLE.description,
    articleCountry: ARTICLE.country,
    relevance: 0.72,
    relatedFacts: ARTICLE.relatedFacts,
    nonce: NONCE,
  };
  p['reasonUser'] = () => prompts.buildReasonUserMessage({ ...reasonParams, publication: 'NOS (Dutch)' });
  p['reasonUser:bare'] = () =>
    prompts.buildReasonUserMessage({ userContext: USER_CONTEXT, articleTitle: 'T', articleDescription: 'D', relevance: 0.5, nonce: NONCE });
  p['localReasonUser'] = () => prompts.buildLocalReasonUserMessage(reasonParams);

  for (const id of PERSONA_SKILL_IDS) {
    p[`skillBody:${id}`] = () => PERSONA_SKILLS[id];
    p[`skillLoaded:${id}`] = () => loadSkill(id);
  }
  for (const surface of ['ONBOARDING', 'CONFIG'] as const)
    for (const languageName of langs)
      for (const webSearch of bools)
        for (const answerPending of bools)
          p[`router:${[surface, languageName ?? 'auto', flag('web', webSearch), flag('pending', answerPending)].join('/')}`] = () =>
            buildRouterPrompt({ surface, languageName, webSearch, answerPending });
  p['factRemoved:one'] = () => factRemovedPrompt(['Lives in Utrecht']);
  p['factRemoved:two-hindi'] = () => factRemovedPrompt(['Lives in Utrecht', 'Into "hiking"'], 'Hindi');
  for (const webSearch of bools) {
    const abilities = ['articleContext', 'profile', 'feed', 'follow', 'factCheck', 'howMeraWorks'] as const;
    p[`identity:${flag('web', webSearch)}`] = () => meraIdentity({ abilities, webSearch });
    p[`routeIdentity:${flag('web', webSearch)}`] = () => meraRouteIdentity({ abilities: ['follow'], webSearch });
  }
  for (const languageName of langs) {
    p[`voiceRules:${languageName ?? 'auto'}`] = () => voiceRules(languageName);
    p[`brandRule:${languageName ?? 'auto'}`] = () => brandRule(languageName);
  }

  for (const needsToolFormat of bools)
    for (const webSearch of bools)
      for (const factCheck of bools)
        for (const factPlaces of bools)
          for (const languageName of langs)
            p[`articleSystem:${[flag('tools', needsToolFormat), flag('web', webSearch), flag('factCheck', factCheck),
              flag('places', factPlaces), languageName ?? 'auto'].join('/')}`] = () =>
              buildArticleFeedbackSystemPrompt({ needsToolFormat, webSearch, factCheck, factPlaces, languageName });
  for (const needsToolFormat of bools)
    for (const canSearch of bools)
      for (const webSearch of bools)
        for (const languageName of langs)
          p[`followSystem:${[flag('tools', needsToolFormat), flag('search', canSearch), flag('web', webSearch),
            languageName ?? 'auto'].join('/')}`] = () =>
            buildFollowStorySystemPrompt({ needsToolFormat, canSearch, webSearch, languageName });
  for (const mode of ['CLOUD', 'LOCAL'] as const)
    for (const web of bools) {
      p[`articleTools:${mode}/${flag('web', web)}`] = () => getArticleFeedbackToolDefinitions(mode, web);
      p[`followTools:${mode}/${flag('web', web)}`] = () => getFollowStoryToolDefinitions(mode, web);
    }
  p['followContext'] = () => buildFollowStoryContext({ nowMs: NOW, proposal: null });
  return p;
}

// --- Device: today's on-device flow prompts ---------------------------------------------------

const HISTORY = [
  { role: 'user' as const, content: 'I live in Utrecht' },
  { role: 'assistant' as const, content: 'Got it. What do you do for work?' },
  { role: 'user' as const, content: 'I am a nurse at the UMC' },
];
const PERSONA_CONTEXT = {
  facts: [
    { id: 'f1', statement: 'Lives in Utrecht, Netherlands, Europe', attribute: 'location: residence' },
    { id: 'f2', statement: 'Commutes by train' },
  ],
  topicPlanNotes: '- Saved topics for f1',
  pending: 'A change is waiting for the user\'s yes or no: Add fact "Works as a nurse"',
};
const ARTICLE_CONTEXT = {
  today: '2026-11-10',
  published: '2026-11-09',
  title: ARTICLE.title,
  publication: 'NOS',
  description: ARTICLE.description,
  category: 'Transport',
  entities: ['NS', 'FNV'],
  relevance: 0.72,
  note: 'Your train commute is hit.',
  matchedTopics: ['Utrecht public transport'],
  producingFacts: ['Commutes by train'],
  relatedCoverage: ['NS strike extended'],
  alreadyFollowing: false,
  verdict: 'dislike' as const,
  pending: 'A change is waiting',
  answers: ['Not about my city: Utrecht (applied)'],
  screen: 'Feed',
  mistakes: ['Wrong place; story from NOS, NL, nl'],
};
const PENDING = { text: 'A change is waiting for the user\'s yes or no: follow "Utrecht rail strike"', tapOnly: false };
const WRITER_REPLY = {
  reply: 'Here you go.',
  save: [{ statement: 'Works as a nurse', attribute: 'profession: job' }],
  options: [{ label: 'Utrecht Rail Strike', search: 'Utrecht rail strike NS' }],
  change: 'less',
};

/** One Kev flow turn per reading Kev can give, with every decide request and writer call captured. */
async function kevRun(
  intents: readonly string[],
  run: (ports: KevPorts, messages: readonly KevMessage[]) => Promise<unknown>,
): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = {};
  for (const forced of intents) {
    const calls: unknown[] = [];
    const ports: KevPorts = {
      decide: (async (request: { questions: Record<string, { criteria: Record<string, unknown> }> }) => {
        calls.push({ decide: request });
        const answers: Record<string, unknown> = {};
        for (const [id, q] of Object.entries(request.questions)) {
          const keys = Object.keys(q.criteria);
          const choice = keys.includes(forced) ? forced : keys[0];
          answers[id] = { type: 'choice', choice, probabilities: { [choice]: 0.9 }, confidence: 0.9 };
        }
        return { model: 'fake', answers, usage: { input_tokens: 1, output_tokens: 0 } };
      }) as unknown as KevPorts['decide'],
      write: (async (system: string, prompt: string, schema: unknown) => {
        calls.push({ system, prompt, schema });
        return WRITER_REPLY;
      }) as KevPorts['write'],
      budget: async () => 3000,
      t: (key) => key,
    };
    const result = (await run(ports, [{ role: 'user', content: 'Something about the Utrecht rail strike' }])) as {
      reply: string;
      calls: unknown[];
    };
    // The trace carries wall-clock timings; the reply and the tool calls are the prompt's outcome.
    out[forced] = { calls, reply: result.reply, toolCalls: result.calls };
  }
  return out;
}


/**
 * The on-device prompt modules loaded afresh. They read DEVICE_SLOTS (ON_DEVICE_HARNESS) at
 * import, so `{ folder }` swaps DEVICE_SLOTS for that folder's slots (device-base, the frozen
 * base, is pinned this way), and `{ afm }` replaces afm/'s overrides in the generated module, so
 * the real afm resolution runs.
 */
function loadDeviceModules(opts: { folder: string } | { afm: Record<string, string> }) {
  let m!: DeviceModules;
  jest.isolateModules(() => {
    if ('folder' in opts) {
      const actual = jest.requireActual('@/lib/harnesses/slots');
      jest.doMock('@/lib/harnesses/slots', () => ({ ...actual, DEVICE_SLOTS: actual.resolveSlots(opts.folder) }));
    } else {
      const actual = jest.requireActual('@/lib/harnesses/slots.generated');
      jest.doMock('@/lib/harnesses/slots.generated', () => ({ ...actual, HARNESS_SLOTS: { ...actual.HARNESS_SLOTS, afm: opts.afm } }));
    }
    m = requireDeviceModules();
  });
  jest.dontMock('@/lib/harnesses/slots');
  jest.dontMock('@/lib/harnesses/slots.generated');
  return m;
}

function requireDeviceModules() {
  return {
    shared: require('@/lib/news-harness/on-device/shared') as typeof import('@/lib/news-harness/on-device/shared'),
    personaChat: require('@/lib/news-harness/on-device/persona-chat/prompt') as typeof import('@/lib/news-harness/on-device/persona-chat/prompt'),
    articleChat: require('@/lib/news-harness/on-device/article-feedback/prompt') as typeof import('@/lib/news-harness/on-device/article-feedback/prompt'),
    followChat: require('@/lib/news-harness/on-device/follow-story/prompt') as typeof import('@/lib/news-harness/on-device/follow-story/prompt'),
    moreOptions: require('@/lib/news-harness/on-device/follow-story/more-options') as typeof import('@/lib/news-harness/on-device/follow-story/more-options'),
    tutorialHelp: require('@/lib/news-harness/on-device/tutorial-help/prompt') as typeof import('@/lib/news-harness/on-device/tutorial-help/prompt'),
    topicGen: require('@/lib/news-harness/on-device/topic-gen/prompt') as typeof import('@/lib/news-harness/on-device/topic-gen/prompt'),
    storyScope: require('@/lib/news-harness/on-device/story-scope/prompt') as typeof import('@/lib/news-harness/on-device/story-scope/prompt'),
    notes: require('@/lib/news-harness/on-device/notes/prompt') as typeof import('@/lib/news-harness/on-device/notes/prompt'),
    subscriptionRead: require('@/lib/news-harness/on-device/subscription-read/prompt') as typeof import('@/lib/news-harness/on-device/subscription-read/prompt'),
    persona: require('@/lib/news-harness/on-device/persona-chat/kev-spec') as typeof import('@/lib/news-harness/on-device/persona-chat/kev-spec'),
    article: require('@/lib/news-harness/on-device/article-feedback/kev-spec') as typeof import('@/lib/news-harness/on-device/article-feedback/kev-spec'),
    follow: require('@/lib/news-harness/on-device/follow-story/kev-spec') as typeof import('@/lib/news-harness/on-device/follow-story/kev-spec'),
  };
}
type DeviceModules = ReturnType<typeof requireDeviceModules>;

function deviceProducers(m: DeviceModules): Record<string, Producer> {
  const { shared, personaChat, articleChat, followChat, moreOptions, tutorialHelp, topicGen, storyScope, notes, subscriptionRead } = m;
  const p: Record<string, Producer> = {};
  const constants: [string, unknown, string][] = [
    ['shared', shared, 'IDENTITY_LINE'],
    ['follow-story', followChat, 'TRACK_OPTION_RULES'],
    ['more-options', moreOptions, 'MORE_OPTIONS_SYSTEM'],
    ['topic-gen', topicGen, 'TOPIC_GEN_SYSTEM'],
    ['story-scope', storyScope, 'STORY_SCOPE_SYSTEM'],
    ['notes', notes, 'NOTE_SYSTEM'],
    ['subscription-read', subscriptionRead, 'SUBSCRIPTION_READ_SYSTEM'],
  ];
  for (const [mod, mod_, name] of constants) p[`const:${mod}#${name}`] = () => (mod_ as Record<string, unknown>)[name];

  for (const languageName of langs) {
    const l = languageName ?? 'auto';
    p[`languageLine:${l}`] = () => shared.languageLine(languageName);
    for (const surface of ['ONBOARDING', 'CONFIG'] as const)
      p[`personaInstructions:${surface}/${l}`] = () => personaChat.personaChatInstructions(surface, languageName);
    p[`articleInstructions:${l}`] = () => articleChat.articleFeedbackInstructions(languageName);
    p[`followInstructions:${l}`] = () => followChat.followStoryInstructions(languageName);
    p[`tutorialInstructions:${l}`] = () => tutorialHelp.tutorialHelpInstructions(languageName);
  }
  for (const surface of ['ONBOARDING', 'CONFIG'] as const) {
    p[`personaPrompt:${surface}`] = () => personaChat.buildPersonaChatPrompt(surface, PERSONA_CONTEXT, HISTORY, 3000);
    p[`personaPrompt:${surface}/empty`] = () => personaChat.buildPersonaChatPrompt(surface, { facts: [] }, HISTORY, 40);
  }
  p['articlePrompt:full'] = () => articleChat.buildArticleFeedbackPrompt(ARTICLE_CONTEXT, HISTORY, 3000);
  p['articlePrompt:minimal'] = () =>
    articleChat.buildArticleFeedbackPrompt(
      { today: '2026-11-10', title: 'T', relevance: null, matchedTopics: [], producingFacts: [], relatedCoverage: [] },
      HISTORY,
      3000,
    );
  p['followPrompt:pending'] = () => followChat.buildFollowStoryPrompt({ today: '2026-11-10', pending: PENDING.text }, HISTORY, 3000);
  p['followPrompt:plain'] = () => followChat.buildFollowStoryPrompt({ today: '2026-11-10' }, HISTORY, 3000);
  p['tutorialPrompt:guide'] = () => tutorialHelp.buildTutorialHelpOnDevicePrompt(null, HISTORY, 3000);
  p['tutorialPrompt:route'] = () => tutorialHelp.buildTutorialHelpOnDevicePrompt('/tutorial/feed/1', HISTORY, 3000);
  p['topicGenPrompt'] = () => topicGen.buildTopicGenPrompt({ factStatement: 'Works as a nurse', excludeTopics: ['Dutch nurse pay', 'Hospital strikes'] }, 5);
  p['topicGenPrompt:tight'] = () =>
    topicGen.buildTopicGenPrompt({ factStatement: 'Works as a nurse', excludeTopics: ['Dutch nurse pay', 'Hospital strikes'] }, 5, 420);
  p['storyScopePrompt'] = () => storyScope.buildOnDeviceStoryScopePrompt(['NS strike halts trains', 'Strike extended'], NOW);
  p['notePrompt'] = () =>
    notes.buildNotePrompt({ userContext: USER_CONTEXT, articleTitle: ARTICLE.title, articleDescription: ARTICLE.description, relevance: 0.72, nonce: NONCE });
  p['subscriptionReadPrompt:full'] = () =>
    subscriptionRead.buildSubscriptionReadPrompt({
      anchorTitle: 'Rail strike', publicationName: 'NRC', title: 'T', description: 'D', category: 'Transport', eventType: 'strike',
    });
  p['subscriptionReadPrompt:bare'] = () =>
    subscriptionRead.buildSubscriptionReadPrompt({ anchorTitle: null, publicationName: null, title: null, description: null, category: null, eventType: null });
  p['moreOptions'] = async () => {
    const calls: unknown[] = [];
    await moreOptions.runMoreTrackOptions(
      {
        today: '2026-11-10',
        shown: [{ label: 'Utrecht Rail Strike', searchText: 'Utrecht rail strike' }],
        room: 3,
        subject: { kind: 'article', articleId: 'a1', title: 'T' } as never,
        articleTitle: 'Rail strike',
      },
      {
        write: (async (system: string, prompt: string, schema: unknown) => {
          calls.push({ system, prompt, schema });
          return WRITER_REPLY;
        }) as never,
        budget: async () => 3000,
      },
    );
    return calls;
  };
  for (const surface of ['ONBOARDING', 'CONFIG'] as const)
    for (const languageName of langs)
      p[`kevPersona:${surface}/${languageName ?? 'auto'}`] = () =>
        kevRun(m.persona.PERSONA_INTENTS, (ports, messages) =>
          m.persona.runPersonaKevTurn({ surface, facts: PERSONA_CONTEXT.facts, topicPlanNotes: null, pending: PENDING, languageName }, messages, ports),
        );
  for (const languageName of langs)
    p[`kevArticle:${languageName ?? 'auto'}`] = () =>
      kevRun(m.article.ARTICLE_KEV_INTENTS, (ports, messages) =>
        m.article.runArticleKevTurn({ context: ARTICLE_CONTEXT, pendingTapOnly: false, languageName }, messages, ports),
      );
  for (const languageName of langs)
    p[`kevFollow:${languageName ?? 'auto'}`] = () =>
      kevRun(m.follow.FOLLOW_KEV_INTENTS, (ports, messages) => m.follow.runFollowKevTurn({ today: '2026-11-10', pending: PENDING, languageName }, messages, ports));
  return p;
}

const PRODUCERS: Record<Base, () => Record<string, Producer>> = {
  'cloud-base': cloudProducers,
  'device-base': () => deviceProducers(loadDeviceModules({ folder: 'device-base' })),
};

interface Snapshot {
  /** Each serving harness folder and the base its prompts come from. */
  folders: Record<string, Base>;
  prompts: Record<Base, Record<string, string>>;
  /** What the phone sends from ON_DEVICE_HARNESS: only the hashes that differ from device-base. */
  onDevice: Record<string, string>;
}

async function hashAll(producers: Record<string, Producer>, label: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const [key, produce] of Object.entries(producers)) {
    const value = await produce();
    if (value === undefined) throw new Error(`${label} ${key}: produced undefined`);
    out[key] = sha(value);
  }
  return out;
}

const differing = (from: Record<string, string>, to: Record<string, string>) =>
  Object.fromEntries(Object.entries(to).filter(([k, v]) => from[k] !== v));

describe('prompt hashes', () => {
  let current: Snapshot;

  beforeAll(async () => {
    const folders: Record<string, Base> = {};
    for (const folder of Object.keys(HARNESS_FILES).sort()) {
      if ((BASES as readonly string[]).includes(folder)) continue;
      folders[folder] = loadHarness(folder).chain[0] as Base;
    }
    const deviceBase = await hashAll(PRODUCERS['device-base'](), 'device-base');
    // The modules as the app imports them, with no swap: what ON_DEVICE_HARNESS sends.
    const sent = await hashAll(deviceProducers(requireDeviceModules()), ON_DEVICE_HARNESS);
    current = {
      folders,
      prompts: { 'cloud-base': await hashAll(PRODUCERS['cloud-base'](), 'cloud-base'), 'device-base': deviceBase },
      onDevice: differing(deviceBase, sent),
    };
    if (process.env.UPDATE_PROMPT_HASHES) fs.writeFileSync(SNAPSHOT, `${JSON.stringify(current, null, 2)}\n`);
  });

  it(`sends device-base plus exactly the pinned ${ON_DEVICE_HARNESS} overrides on device`, () => {
    const pinned = JSON.parse(fs.readFileSync(SNAPSHOT, 'utf8')) as Snapshot;
    expect(current.onDevice).toEqual(pinned.onDevice);
  });

  it('an afm/ override changes exactly the on-device prompts built from that slot', async () => {
    expect(ON_DEVICE_HARNESS).toBe('afm');
    const base = await hashAll(deviceProducers(loadDeviceModules({ folder: 'device-base' })), 'device-base');
    const changedBy = async (afm: Record<string, string>) =>
      Object.keys(differing(base, await hashAll(deviceProducers(loadDeviceModules({ afm })), 'override')));
    expect(await changedBy({})).toEqual([]);
    expect(await changedBy({ 'notes/note-system': 'An override note prompt.' })).toEqual(['const:notes#NOTE_SYSTEM', 'notePrompt']);
    expect(await changedBy({ 'story-scope/story-scope-system': 'An override scope prompt.' })).toEqual([
      'const:story-scope#STORY_SCOPE_SYSTEM',
      'storyScopePrompt',
    ]);
  });

  it('serves each harness folder from the base its snapshot names', () => {
    const pinned = JSON.parse(fs.readFileSync(SNAPSHOT, 'utf8')) as Snapshot;
    expect(current.folders).toEqual(pinned.folders);
  });

  it.each(BASES)('every prompt %s serves hashes as pinned', (base) => {
    const pinned = JSON.parse(fs.readFileSync(SNAPSHOT, 'utf8')) as Snapshot;
    const changed = Object.keys({ ...pinned.prompts[base], ...current.prompts[base] })
      .filter((k) => pinned.prompts[base][k] !== current.prompts[base][k])
      .sort();
    expect(changed).toEqual([]);
  });

  it('pins a non-trivial set, so a producer that went missing cannot pass by omission', () => {
    expect(Object.keys(current.prompts['cloud-base']).length).toBeGreaterThan(500);
    expect(Object.keys(current.prompts['device-base']).length).toBeGreaterThan(30);
  });
});
