// harness-local: manage TEST accounts headlessly, staging or prod, with no OTP.
//
//   npx tsx --tsconfig harness-local/tsconfig.json harness-local/scripts/test-account.ts \
//     <sign-in <handle> | new | list | reset <handle> | delete <handle>> --env staging|prod
//
// Reads mera-app/.env.agent.<env> (git-ignored; the same file the agent Metro
// sources): EXPO_PUBLIC_AUTH_ENDPOINT and EXPO_PUBLIC_TEST_ACCOUNT_TOKEN. The
// token is never printed, and the file is parsed, never loaded into
// process.env. Only the /test-account/* routes are called; nothing else in
// prod is touched.

import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

import * as dotenv from 'dotenv';

import { TEST_ACCOUNT_HANDLE_PATTERN, callTestAccountRoute } from '../adapters/auth';

type Command = 'sign-in' | 'new' | 'list' | 'reset' | 'delete';
const COMMANDS: readonly Command[] = ['sign-in', 'new', 'list', 'reset', 'delete'];
const USAGE =
  'usage: test-account.ts <sign-in <handle> | new | list | reset <handle> | delete <handle>> --env staging|prod';

function fail(message: string): never {
  console.error(`test-account: ${message}`);
  process.exit(1);
}

/** The env file's endpoint and token, checked against the env it claims. */
function loadAgentEnv(env: 'staging' | 'prod'): { authEndpoint: string; token: string } {
  const file = path.resolve(__dirname, '..', '..', `.env.agent.${env}`);
  if (!fs.existsSync(file)) fail(`${path.basename(file)} not found in mera-app/ (see the mera-app-harness skill).`);
  const vars = dotenv.parse(fs.readFileSync(file));
  const authEndpoint = vars.EXPO_PUBLIC_AUTH_ENDPOINT?.trim().replace(/\/+$/, '');
  const token = vars.EXPO_PUBLIC_TEST_ACCOUNT_TOKEN?.trim();
  if (!authEndpoint) fail(`EXPO_PUBLIC_AUTH_ENDPOINT is missing in ${path.basename(file)}.`);
  if (!token) fail(`EXPO_PUBLIC_TEST_ACCOUNT_TOKEN is missing in ${path.basename(file)}.`);
  // A mislabelled file must not send a staging command to prod, or the reverse.
  const host = new URL(authEndpoint).hostname;
  const isStaging = host.endsWith('.staging.mera.news');
  if (env === 'staging' && !isStaging) fail(`${path.basename(file)} points at ${host}, not a staging host.`);
  if (env === 'prod' && (isStaging || !host.endsWith('mera.news'))) fail(`${path.basename(file)} points at ${host}, not prod.`);
  return { authEndpoint, token };
}

function explain(status: number): string {
  return status === 404
    ? '404: a wrong or missing token, test accounts disabled, an unknown handle on delete, or the route not deployed (the server answers them the same).'
    : `HTTP ${status}.`;
}

async function signIn(authEndpoint: string, token: string, handle: string): Promise<void> {
  const { status, body } = await callTestAccountRoute(authEndpoint, token, 'sign-in', handle);
  if (status < 200 || status >= 300) fail(`sign-in ${handle} failed. ${explain(status)}`);
  const typed = body as { user?: { id?: string }; minted?: boolean } | null;
  console.log(`${typed?.minted === true ? 'minted' : 'resumed'} handle=${handle} userId=${typed?.user?.id ?? '?'}`);
}

async function remove(authEndpoint: string, token: string, handle: string, { missingOk = false } = {}): Promise<void> {
  const { status } = await callTestAccountRoute(authEndpoint, token, 'delete', handle);
  if (status >= 200 && status < 300) {
    console.log(`deleted handle=${handle}`);
    return;
  }
  if (status === 404 && missingOk) {
    console.log(`nothing to delete for handle=${handle}`);
    return;
  }
  fail(`delete ${handle} failed. ${explain(status)}`);
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const envAt = argv.indexOf('--env');
  const env = envAt === -1 ? undefined : argv[envAt + 1];
  if (env !== 'staging' && env !== 'prod') fail(USAGE);
  const positional = argv.filter((_, i) => i !== envAt && i !== envAt + 1);
  const [command, handleArg] = positional as [Command | undefined, string | undefined];
  if (!command || !COMMANDS.includes(command)) fail(USAGE);
  const needsHandle = command === 'sign-in' || command === 'reset' || command === 'delete';
  if (needsHandle && (!handleArg || !TEST_ACCOUNT_HANDLE_PATTERN.test(handleArg))) {
    fail(`${command} needs a handle matching ${TEST_ACCOUNT_HANDLE_PATTERN}.`);
  }

  const { authEndpoint, token } = loadAgentEnv(env);
  const handle = handleArg as string;

  switch (command) {
    case 'sign-in':
      return signIn(authEndpoint, token, handle);
    case 'new':
      return signIn(authEndpoint, token, `tmp-${randomUUID().replace(/-/g, '').slice(0, 12)}`);
    case 'reset':
      await remove(authEndpoint, token, handle, { missingOk: true });
      return signIn(authEndpoint, token, handle);
    case 'delete':
      return remove(authEndpoint, token, handle);
    case 'list': {
      const { status, body } = await callTestAccountRoute(authEndpoint, token, 'list');
      if (status < 200 || status >= 300) fail(`list failed. ${explain(status)}`);
      const accounts = (body as { accounts?: { handle?: string; userId?: string }[] } | null)?.accounts ?? [];
      if (accounts.length === 0) console.log('no test accounts');
      for (const a of accounts) console.log(`${a.handle ?? '?'} userId=${a.userId ?? '?'}`);
      return;
    }
  }
}

main().catch((error: unknown) => {
  // Never the token: only the error's own message, which this script and the
  // adapter build without it.
  fail(error instanceof Error ? error.message : String(error));
});
