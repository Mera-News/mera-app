// App entry point (package.json "main").
//
// The OS background tasks are defined FIRST, then the router entry. Under
// expo-router, app/_layout.tsx is evaluated only when a route renders, so a
// killed app woken headless by the OS would otherwise find its tasks undefined,
// and expo-task-manager unregisters an undefined task. Metro resolves this file
// from "main" when the bundle is built, so a change here ships by OTA.
import './lib/background/define-tasks';
import 'expo-router/entry';
