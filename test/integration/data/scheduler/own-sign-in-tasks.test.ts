// The names the sign-in exemption lists are the real tasks, and each of them carries the sign-in condition
// the host member is asked about. The scheduler asking the host by task name is the client's own test.
import '@/lib/scheduler/tasks/feed-sync-task';
import '@/lib/scheduler/tasks/persona-hygiene-task';
import '@/lib/scheduler/tasks/feedback-request-sync-task';
import { AppScheduler } from '@/lib/scheduler/AppScheduler';

it.each(['feed-sync', 'persona-hygiene', 'feedback-request-sync'])('the real %s task checks the Mera sign-in', (name) => {
  expect(AppScheduler.definition(name)?.conditions).toContainEqual({ type: 'authenticated' });
});
