// harness-local — the staging rail.
//
// WHY THIS EXISTS. `.env.harness` is a gitignored file the user edits in
// parallel, and it has shipped pointed at PROD (target `prod`, the live
// graphql.mera.news / auth.mera.news hosts). Every agent-run script in this
// wave hits the article-delivery endpoint that spends the real daily per-user
// quota, so "staging only" enforced by that file is a guarantee nobody can
// check. This module enforces it on the RESOLVED endpoint strings instead:
// a hostname either ends with `.staging.mera.news` or the run does not start.
//
// SCOPE. Opt-in at the call site, mandatory for every runner an agent starts.
// The pre-existing scripts (replay-persona-chat, replay-fact-extraction, the
// two test-news-harness runners) keep working untouched — they are the
// instruments that produced the MODEL_FALLBACKS table and the user points them
// wherever they like. They get a loud banner from loadHarnessEnv instead.
//
// Node-only. Imports nothing from expo/react-native.

export type HarnessTarget = 'local' | 'staging' | 'prod';

/** The staging hosts, used to FILL an endpoint the env file left unset. Never
 *  to rewrite one it set: silently redirecting a developer's explicit endpoint
 *  is how a run ends up measuring a different environment than its label says. */
export const STAGING_DEFAULTS = {
  graphqlEndpoint: 'https://graphql.staging.mera.news/graphql',
  authEndpoint: 'https://auth.staging.mera.news',
  inferenceEndpoint: 'https://inference.staging.mera.news',
} as const;

/** Suffix a mera host must carry to count as staging. Matched as a DNS suffix,
 *  not a substring: `staging.mera.news.evil.test` and a query string carrying
 *  the word "staging" both fail, where an `includes('staging')` check passes
 *  them both. */
const STAGING_SUFFIX = '.staging.mera.news';

/** Any mera-owned host. A host under this that is not staging is refused. */
const MERA_SUFFIX = '.mera.news';

export function hostnameOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    throw new Error(`harness-local: not a usable URL: ${JSON.stringify(url)}`);
  }
}

export function isStagingHost(url: string): boolean {
  return hostnameOf(url).endsWith(STAGING_SUFFIX);
}

export function isProdMeraHost(url: string): boolean {
  const host = hostnameOf(url);
  return host.endsWith(MERA_SUFFIX) && !host.endsWith(STAGING_SUFFIX);
}

/**
 * Refuses anything that is not a staging mera host. A prod host is named as
 * prod in the error, because "endpoint failed the staging check" reads as a
 * typo where "this is the PROD host" reads as the mistake it is.
 */
export function assertStagingEndpoint(varName: string, url: string): void {
  if (isStagingHost(url)) return;
  if (isProdMeraHost(url)) {
    throw new Error(
      `harness-local: ${varName} is the PROD host (${hostnameOf(url)}). ` +
        'This runner is staging-only and will not query prod. ' +
        `Unset ${varName} to take the staging default (${STAGING_DEFAULTS.graphqlEndpoint.replace('graphql', '<service>')}), ` +
        'or point it at a *.staging.mera.news host.',
    );
  }
  throw new Error(
    `harness-local: ${varName} (${hostnameOf(url)}) is not a *${STAGING_SUFFIX} host. ` +
      'This runner is staging-only.',
  );
}

/**
 * The whole rail, in one call. Every runner an agent starts calls this
 * immediately after loadHarnessEnv and before any network work.
 *
 * NOTE on what is NOT checked: `nearAiBaseUrl` (cloud-api.near.ai) is a
 * third-party model API, not a mera environment — it has no staging twin and
 * carrying a NEAR key is not a prod-data risk. The rail is about mera data.
 */
export function requireStagingTarget(env: {
  target: HarnessTarget;
  graphqlEndpoint: string;
  authEndpoint: string;
  inferenceEndpoint?: string;
}): void {
  if (env.target !== 'staging') {
    throw new Error(
      `harness-local: this runner is staging-only, but the resolved target is '${env.target}'. ` +
        'Pass --target staging (it overrides NEWS_HARNESS_TARGET for the process).',
    );
  }
  assertStagingEndpoint('NEWS_HARNESS_GRAPHQL_ENDPOINT', env.graphqlEndpoint);
  assertStagingEndpoint('NEWS_HARNESS_AUTH_ENDPOINT', env.authEndpoint);
  if (env.inferenceEndpoint) {
    assertStagingEndpoint('NEWS_HARNESS_INFERENCE_ENDPOINT', env.inferenceEndpoint);
  }
}

/**
 * Per-endpoint CLI overrides, applied the same way and for the same reason as
 * `applyTargetOverride`: written into process.env BEFORE dotenv runs, so the
 * flag beats `.env.harness` without any runner editing a file the user also
 * edits.
 *
 * WHY THIS IS NOT OPTIONAL POLISH. `.env.harness` on this machine sets the
 * endpoints EXPLICITLY to the prod hosts, and the loader passes a set endpoint
 * through untouched by design, so `--target staging` on its own hard-fails at
 * the guard with "is the PROD host". Without these flags a staging run is
 * impossible here unless someone edits that file, which is exactly what the
 * user's parallel edits make unsafe. Overridden values still go through
 * `assertStagingEndpoint` like any other: this changes WHERE the value comes
 * from, never WHETHER it is checked.
 *
 * Returns the names of the variables it set, for the run manifest.
 */
export function applyEndpointOverrides(argv: string[]): string[] {
  const FLAGS: Record<string, string> = {
    '--graphql-endpoint': 'NEWS_HARNESS_GRAPHQL_ENDPOINT',
    '--auth-endpoint': 'NEWS_HARNESS_AUTH_ENDPOINT',
    '--inference-endpoint': 'NEWS_HARNESS_INFERENCE_ENDPOINT',
  };
  const applied: string[] = [];
  for (const [flag, varName] of Object.entries(FLAGS)) {
    const i = argv.indexOf(flag);
    if (i === -1) continue;
    const value = argv[i + 1]?.trim();
    if (!value || value.startsWith('--')) {
      throw new Error(`harness-local: ${flag} needs a URL.`);
    }
    process.env[varName] = value;
    applied.push(varName);
  }
  return applied;
}

/** Reads `--target <t>` out of argv without consuming it, so a runner's own
 *  parser still sees the flag. Returns undefined when absent. */
export function parseTargetFlag(argv: string[]): HarnessTarget | undefined {
  const i = argv.indexOf('--target');
  if (i === -1) return undefined;
  const raw = argv[i + 1]?.trim();
  if (raw !== 'local' && raw !== 'staging' && raw !== 'prod') {
    throw new Error(
      `harness-local: --target must be one of 'local' | 'staging' | 'prod' (got ${JSON.stringify(raw ?? '')}).`,
    );
  }
  return raw;
}

/**
 * Applies `--target` as a process-wide override BEFORE the env file is read.
 * dotenv never overwrites a variable already present in process.env, so
 * setting it here wins over `.env.harness` without editing that file — which
 * matters because the user edits it in parallel and a runner must not.
 *
 * Call this as the first statement of a runner's main().
 */
export function applyTargetOverride(argv: string[]): HarnessTarget | undefined {
  const target = parseTargetFlag(argv);
  if (target) process.env.NEWS_HARNESS_TARGET = target;
  return target;
}
