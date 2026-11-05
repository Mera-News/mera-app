// The one identity every chat surface takes: it states web search only where the tool is offered,
// keeps the page rule off the route leg, and says what each surface really does.
import { IDENTITY_LINE, WHY_NO_PAGES, meraIdentity, meraRouteIdentity } from '@/lib/mera-harness/core/identity';
import { buildRouterPrompt } from '@/lib/mera-harness/core/router-prompt';
import { buildArticleFeedbackSystemPrompt } from '@/lib/news-harness/article-feedback/agent-core';
import { buildFollowStorySystemPrompt } from '@/lib/news-harness/follow-story';
import { countTokens } from '@/lib/news-harness/on-device/shared';
import { buildTutorialHelpPrompt } from '@/lib/news-harness/tutorial-help';

const CAN_SEARCH = 'You can make a web search request';
const NO_PAGES = 'You do not open a page or read an article.';
const TOGGLE = 'Web search in chat';

it('with search offered it can search, cannot open a page, offers a search and keeps the reason', () => {
  const text = meraIdentity({ abilities: ['follow'], webSearch: true });
  for (const line of [CAN_SEARCH, NO_PAGES, 'offer to search for it instead', WHY_NO_PAGES]) expect(text).toContain(line);
  expect(text).not.toContain(TOGGLE);
});

it('with search off it claims no search and names the toggle', () => {
  const text = meraIdentity({ abilities: ['follow'], webSearch: false });
  expect(text).not.toContain(CAN_SEARCH);
  expect(text).not.toContain('offer to search');
  for (const line of [NO_PAGES, TOGGLE, 'Mera Protocol settings', WHY_NO_PAGES]) expect(text).toContain(line);
});

it('the route leg says who it is and leaves the page rule to the skill legs', () => {
  const text = meraRouteIdentity({ abilities: ['follow'], webSearch: true });
  expect(text).toContain(CAN_SEARCH);
  expect(text).not.toContain('open a page');
  expect(meraRouteIdentity({ abilities: ['follow'], webSearch: false })).not.toContain('search');
});

it('the router states search only when the flag says it is offered', () => {
  expect(buildRouterPrompt({ surface: 'CONFIG', webSearch: true })).toContain(CAN_SEARCH);
  const off = buildRouterPrompt({ surface: 'CONFIG', webSearch: false });
  expect(off).not.toContain(CAN_SEARCH);
  expect(off).not.toContain('updating the user');
  expect(off).not.toContain('Redirect anything else');
});

it('each cloud surface opens on the shared identity and lists only what it does', () => {
  const article = buildArticleFeedbackSystemPrompt({ needsToolFormat: false, webSearch: true, factCheck: true });
  const follow = buildFollowStorySystemPrompt({ needsToolFormat: false, webSearch: false });
  const tutorial = buildTutorialHelpPrompt({ webSearch: false });
  for (const prompt of [article, follow, tutorial]) expect(prompt.startsWith('## Who you are\nYou are Mera, a news assistant.')).toBe(true);
  expect(article).toContain('get more context on this news article');
  expect(article).toContain(CAN_SEARCH);
  expect(follow).toContain('- follow news stories');
  expect(follow).not.toContain('manage their profile');
  expect(tutorial).not.toContain('follow news stories');
  expect(tutorial).toContain(TOGGLE);
});

it('the on-device line stays short and promises no search', () => {
  expect(countTokens(IDENTITY_LINE)).toBeLessThan(50);
  expect(IDENTITY_LINE).not.toContain('search');
  expect(IDENTITY_LINE).toContain('You open no pages.');
});
