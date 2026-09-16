// harness-local — environment loading + validation.
//
// This is a plain Node module (NOT part of lib/news-harness). It NEVER imports
// lib/logger, lib/config/endpoints, or anything expo/react-native — harness-local
// is a standalone Node executor for the RN-free lib/news-harness AI-flow system.

import * as dotenv from 'dotenv';
import * as path from 'node:path';
import { STAGING_DEFAULTS, type HarnessTarget } from '../lib/staging-guard';

export interface HarnessEnv {
  target: HarnessTarget;
  nearAiApiKey: string;
  nearAiBaseUrl: string;
  graphqlEndpoint: string;
  authEndpoint: string;
  /** E2EE inference gateway. Only the gateway lane needs it, so it stays
   *  optional: every runner that posts direct to NEAR works without it. */
  inferenceEndpoint?: string;
  authEmail?: string;
  model?: string;
}

export interface LoadHarnessEnvOptions {
  /**
   * `'staging'` puts the loader on the staging rail: a missing mera endpoint
   * takes its staging default instead of throwing, and the caller is expected
   * to follow up with `requireStagingTarget` (lib/staging-guard) which refuses
   * any endpoint that is not a *.staging.mera.news host.
   *
   * Omitted, the loader behaves exactly as it always has — the pre-existing
   * scripts pass nothing and are unaffected.
   */
  require?: 'staging';
}

const ENV_FILE_NAME = '.env.harness';
const EXAMPLE_FILE_NAME = '.env.harness.example';

function missingVarError(varName: string): Error {
  return new Error(
    `harness-local: missing required environment variable ${varName}. ` +
      `Copy harness-local/${EXAMPLE_FILE_NAME} to harness-local/${ENV_FILE_NAME} and fill it in.`,
  );
}

let loaded = false;
let prodBannerShown = false;

function ensureDotenvLoaded(): void {
  if (loaded) return;
  loaded = true;
  // Load harness-local/.env.harness FIRST — its NEWS_HARNESS_* values are the
  // explicit harness config and must win. dotenv.config never overrides keys
  // already present in process.env, so loading the repo-root .env second can
  // only FILL IN variables .env.harness didn't set — it cannot clobber any
  // NEWS_HARNESS_* value. We load the repo-root .env at all to pick up
  // NEAR_AI_DEVELOPMENT_KEY, the fallback NEAR key (see loadHarnessEnv).
  //
  // The same rule is what makes `--target staging` work: applyTargetOverride
  // writes process.env.NEWS_HARNESS_TARGET before this runs, so the CLI flag
  // beats the file without any runner editing a file the user also edits.
  const envPath = path.resolve(__dirname, '..', ENV_FILE_NAME);
  const appEnvPath = path.resolve(__dirname, '..', '..', '.env');
  // Silent if either file doesn't exist — validation below reports the
  // specific missing variable with a pointer to the example file.
  // `quiet: true` suppresses dotenv's own stdout banner/tips (added in
  // dotenv v17) so harness script output stays clean.
  dotenv.config({ path: envPath, quiet: true });
  dotenv.config({ path: appEnvPath, quiet: true });
}

export function loadHarnessEnv(opts: LoadHarnessEnvOptions = {}): HarnessEnv {
  ensureDotenvLoaded();

  const rawTarget = process.env.NEWS_HARNESS_TARGET?.trim() || 'local';
  if (rawTarget !== 'local' && rawTarget !== 'staging' && rawTarget !== 'prod') {
    throw new Error(
      `harness-local: NEWS_HARNESS_TARGET must be one of 'local' | 'staging' | 'prod' (got '${rawTarget}'). ` +
        `See harness-local/${EXAMPLE_FILE_NAME}.`,
    );
  }
  const target: HarnessTarget = rawTarget;
  const onStagingRail = opts.require === 'staging';

  // One unmissable line when a script is about to talk to PROD. It is not a
  // refusal — the pre-existing scripts are the user's own tools and the file
  // has legitimately been set to prod — but the prod article-delivery endpoint
  // spends the real daily per-user quota, and that should never be a surprise.
  if (target === 'prod' && !prodBannerShown) {
    prodBannerShown = true;
    // eslint-disable-next-line no-console
    console.warn(
      '\n!!  harness-local: NEWS_HARNESS_TARGET=prod. Live PROD endpoints.\n' +
        '!!  Article fetches spend the real daily per-user delivery quota.\n' +
        '!!  Pass --target staging (staging-rail runners refuse prod outright).\n',
    );
  }

  // NEAR key resolution: NEWS_HARNESS_NEARAI_API_KEY (explicit harness
  // override, from .env.harness) wins if set; otherwise fall back to the
  // dedicated dev key NEAR_AI_DEVELOPMENT_KEY from the repo-root .env.
  const nearAiApiKey =
    process.env.NEWS_HARNESS_NEARAI_API_KEY?.trim() ||
    process.env.NEAR_AI_DEVELOPMENT_KEY?.trim();
  if (!nearAiApiKey) {
    throw new Error(
      'harness-local: no NEAR AI API key found. Set NEWS_HARNESS_NEARAI_API_KEY ' +
        `in harness-local/${ENV_FILE_NAME} (see harness-local/${EXAMPLE_FILE_NAME}), ` +
        'or add NEAR_AI_DEVELOPMENT_KEY to the repo-root .env.',
    );
  }

  const nearAiBaseUrl =
    process.env.NEWS_HARNESS_NEARAI_BASE_URL?.trim() || 'https://cloud-api.near.ai/v1';

  // On the staging rail an UNSET mera endpoint takes its staging default; a SET
  // one is passed through untouched so requireStagingTarget can refuse it by
  // name. Filling a default here and refusing a wrong value there keeps those
  // two jobs separate: this function never redirects an explicit endpoint.
  const graphqlEndpoint =
    process.env.NEWS_HARNESS_GRAPHQL_ENDPOINT?.trim() ||
    (onStagingRail ? STAGING_DEFAULTS.graphqlEndpoint : '');
  if (!graphqlEndpoint) throw missingVarError('NEWS_HARNESS_GRAPHQL_ENDPOINT');

  let authEndpoint =
    process.env.NEWS_HARNESS_AUTH_ENDPOINT?.trim() ||
    (onStagingRail ? STAGING_DEFAULTS.authEndpoint : '');
  if (target !== 'local' && !authEndpoint) {
    throw missingVarError('NEWS_HARNESS_AUTH_ENDPOINT');
  }
  authEndpoint = authEndpoint || '';

  const inferenceEndpoint =
    process.env.NEWS_HARNESS_INFERENCE_ENDPOINT?.trim() ||
    (onStagingRail ? STAGING_DEFAULTS.inferenceEndpoint : undefined);

  // The email-OTP flow is only one of two ways onto a non-local target; the
  // staging dev bypass (POST /api/auth/device/sign-in/dev) needs no email at
  // all. So this stays required only OFF the staging rail, where OTP is the
  // only path a script has.
  const authEmail = process.env.NEWS_HARNESS_AUTH_EMAIL?.trim();
  if (target !== 'local' && !onStagingRail && !authEmail) {
    throw missingVarError('NEWS_HARNESS_AUTH_EMAIL');
  }

  const model = process.env.NEWS_HARNESS_MODEL?.trim() || undefined;

  return {
    target,
    nearAiApiKey,
    nearAiBaseUrl,
    graphqlEndpoint,
    authEndpoint,
    inferenceEndpoint,
    authEmail,
    model,
  };
}
