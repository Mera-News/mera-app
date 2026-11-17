// App entry point (package.json "main").
//
// The app host registers FIRST: lib/app-host.ts gives mera-news-client its platform, and many client
// modules read it while they load, so nothing may reach the client before it. Then the OS background
// tasks, then the router entry. Under expo-router, app/_layout.tsx is evaluated only when a route
// renders, so a killed app woken headless by the OS would otherwise find its tasks undefined, and
// expo-task-manager unregisters an undefined task. Metro resolves this file from "main" when the
// bundle is built, so a change here ships by OTA.
import './lib/app-host';
import './lib/background/define-tasks';
import 'expo-router/entry';
