import { ownAiOn } from './own-ai-state';
import { ownNewsOn } from './own-news-state';
import { podPaired } from './pod-state';

// Each name here reaches only servers the person runs while the mode is on; feedback-request-sync is a Mera account feature and keeps its check.
const OWN_SERVER_TASKS = new Set(['feed-sync', 'persona-hygiene']);

export function taskNeedsMeraSignIn(taskName: string): boolean {
  return !(OWN_SERVER_TASKS.has(taskName) && (podPaired() || (ownAiOn() && ownNewsOn())));
}
