// harness-local — environment loading + validation.
//
// This is a plain Node module (NOT part of lib/news-harness). It NEVER imports
// lib/logger, lib/config/endpoints, or anything expo/react-native — harness-local
// is a standalone Node executor for the RN-free lib/news-harness AI-flow system.

import * as dotenv from 'dotenv';
import * as path from 'node:path';

export interface HarnessEnv {
  target: 'local' | 'staging' | 'prod';
  nearAiApiKey: string;
  nearAiBaseUrl: string;
  graphqlEndpoint: string;
  authEndpoint: string;
  authEmail?: string;
  model?: string;
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

function ensureDotenvLoaded(): void {
  if (loaded) return;
  loaded = true;
  // Load harness-local/.env.harness FIRST — its NEWS_HARNESS_* values are the
  // explicit harness config and must win. dotenv.config never overrides keys
  // already present in process.env, so loading the repo-root .env second can
  // only FILL IN variables .env.harness didn't set — it cannot clobber any
  // NEWS_HARNESS_* value. We load the repo-root .env at all to pick up
  // NEAR_AI_DEVELOPMENT_KEY, the fallback NEAR key (see loadHarnessEnv).
  const envPath = path.resolve(__dirname, '..', ENV_FILE_NAME);
  const appEnvPath = path.resolve(__dirname, '..', '..', '.env');
  // Silent if either file doesn't exist — validation below reports the
  // specific missing variable with a pointer to the example file.
  // `quiet: true` suppresses dotenv's own stdout banner/tips (added in
  // dotenv v17) so harness script output stays clean.
  dotenv.config({ path: envPath, quiet: true });
  dotenv.config({ path: appEnvPath, quiet: true });
}

export function loadHarnessEnv(): HarnessEnv {
  ensureDotenvLoaded();

  const rawTarget = process.env.NEWS_HARNESS_TARGET?.trim() || 'local';
  if (rawTarget !== 'local' && rawTarget !== 'staging' && rawTarget !== 'prod') {
    throw new Error(
      `harness-local: NEWS_HARNESS_TARGET must be one of 'local' | 'staging' | 'prod' (got '${rawTarget}'). ` +
        `See harness-local/${EXAMPLE_FILE_NAME}.`,
    );
  }
  const target = rawTarget;

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

  const graphqlEndpoint = process.env.NEWS_HARNESS_GRAPHQL_ENDPOINT?.trim();
  if (!graphqlEndpoint) throw missingVarError('NEWS_HARNESS_GRAPHQL_ENDPOINT');

  let authEndpoint = process.env.NEWS_HARNESS_AUTH_ENDPOINT?.trim();
  if (target !== 'local' && !authEndpoint) {
    throw missingVarError('NEWS_HARNESS_AUTH_ENDPOINT');
  }
  authEndpoint = authEndpoint || '';

  const authEmail = process.env.NEWS_HARNESS_AUTH_EMAIL?.trim();
  if (target !== 'local' && !authEmail) {
    throw missingVarError('NEWS_HARNESS_AUTH_EMAIL');
  }

  const model = process.env.NEWS_HARNESS_MODEL?.trim() || undefined;

  return {
    target,
    nearAiApiKey,
    nearAiBaseUrl,
    graphqlEndpoint,
    authEndpoint,
    authEmail,
    model,
  };
}
