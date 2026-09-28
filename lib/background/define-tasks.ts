// Every OS-woken task, defined at bundle evaluation.
//
// Imported by `index.js` BEFORE `expo-router/entry`. Under expo-router every
// route module, `app/_layout.tsx` included, is evaluated lazily when the router
// renders, and a killed app woken headless (Android WorkManager, a silent push)
// renders nothing. An event for a task that is not defined makes
// expo-task-manager unregister that task, silently.
//
// This runs before the router on every launch, so keep its graph small.
// `background-task` imports only the two expo task modules and the logger and
// requires everything else when a wake runs. `inference-task` still imports its
// handler statically (the chat area owns it); that graph was already evaluated
// at boot when `_layout.tsx` imported it, so moving it here costs no new work.

import { defineBackgroundTask } from './background-task';
import { defineInferenceTask } from './inference-task';

defineBackgroundTask();
defineInferenceTask();
