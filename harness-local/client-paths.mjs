// Resolves @/lib/* for harness-local and eval: mera-news-client first, then the app. tsx applies
// tsconfig paths only to files outside node_modules, so the client's own @/lib imports need this.
// Load it with: npx tsx --tsconfig harness-local/tsconfig.json --import ./harness-local/client-paths.mjs <script>
import { createRequire, registerHooks } from 'node:module';
import { existsSync, statSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
const { APP_ROOT, CLIENT_ROOT } = createRequire(import.meta.url)('../client-resolution.js');
const EXTS = ['', '.ts', '.tsx', '.js', '.json', '/index.ts', '/index.tsx', '/index.js'];
const find = (base) => EXTS.map((e) => base + e).find((f) => existsSync(f) && statSync(f).isFile());
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (!specifier.startsWith('@/lib/')) return nextResolve(specifier, context);
    const rest = specifier.slice(2);
    const file = find(path.join(CLIENT_ROOT, rest)) ?? find(path.join(APP_ROOT, rest));
    return file ? { url: pathToFileURL(file).href, shortCircuit: true } : nextResolve(specifier, context);
  },
});
