/**
 * Scrubbed environment for every process a gate starts (gate commands, the preview server).
 *
 * Gates execute UNTRUSTED code: `pnpm build`, `start`, eslint/playwright/next configs and package.json scripts in a task
 * worktree were all written by a coding agent. Passing `process.env` through would let an agent that is sandboxed
 * itself (e.g. Codex `--sandbox workspace-write`) exfiltrate the developer's secrets by writing them into a script
 * the gate then runs. So child processes get only a small allowlist of variables that tools need to function, plus
 * the names gates.yaml lists explicitly under top-level `env:`. Deploy tokens and LLM/agent credentials are never
 * forwarded, even when gates.yaml names them.
 */

/** Variables every gate process receives from the parent environment (when set there). */
export const BASE_GATE_ENV: readonly string[] = [
  'PATH',
  'HOME',
  'TMPDIR',
  'TMP',
  'TEMP',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'CI',
  'NODE_ENV',
  'PORT',
  // Where `npx playwright install` put the browsers when the developer moved them; not a secret.
  'PLAYWRIGHT_BROWSERS_PATH',
  // Lighthouse's Chrome location when it is not in a default install path; not a secret.
  'CHROME_PATH',
  // Windows needs these for node/npm/cmd to work at all.
  'SYSTEMROOT',
  'COMSPEC',
  'PATHEXT',
  'USERPROFILE',
  'APPDATA',
  'LOCALAPPDATA',
];

/** Name prefixes of credentials that must never reach a gate (deploy tokens, LLM and agent keys, cloud creds). */
const DENIED_PREFIXES = [
  'VERCEL_',
  'NOW_',
  'NETLIFY_',
  'ANTHROPIC_',
  'CLAUDE_',
  'OPENAI_',
  'CODEX_',
  'GEMINI_',
  'GOOGLE_GENAI_',
  'GOOGLE_GENERATIVE_AI_',
  'VERTEX_',
  'AZURE_OPENAI_',
  'AWS_',
  'MISTRAL_',
  'GROQ_',
  'OPENROUTER_',
  'XAI_',
  'DEEPSEEK_',
  'COHERE_',
  'ARTELO_SECRET',
];

/** Exact credential names that must never reach a gate. */
const DENIED_NAMES = new Set([
  'GOOGLE_API_KEY',
  'GOOGLE_APPLICATION_CREDENTIALS',
  'NPM_TOKEN',
  'NODE_AUTH_TOKEN',
  'GITHUB_TOKEN',
  'GH_TOKEN',
  'GITLAB_TOKEN',
  'SSH_AUTH_SOCK',
]);

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

export function isValidEnvName(name: string): boolean {
  return ENV_NAME.test(name);
}

/** True for deploy tokens / LLM keys that gates must never see (case-insensitive). */
export function isDeniedGateEnv(name: string): boolean {
  const upper = name.toUpperCase();
  return DENIED_NAMES.has(upper) || DENIED_PREFIXES.some((p) => upper.startsWith(p));
}

export interface GateEnvOptions {
  /** Extra names to forward from `source` (gates.yaml `env:`). Denied names are dropped. */
  allow?: readonly string[];
  /** Values set by agent-gates itself (CI, PORT, PLAYWRIGHT_JSON_OUTPUT_NAME, ...); applied last. */
  set?: Readonly<Record<string, string>>;
  /** Parent environment (default `process.env`). */
  source?: NodeJS.ProcessEnv;
}

/**
 * Build the environment for a gate child process: allowlisted names copied from `source`, then `set`. Nothing
 * else from the parent environment is inherited.
 */
export function buildGateEnv(opts: GateEnvOptions = {}): Record<string, string> {
  const source = opts.source ?? process.env;
  const names = new Set([...BASE_GATE_ENV, ...(opts.allow ?? [])]);
  const env: Record<string, string> = {};
  // Windows env names are case-insensitive (`Path`); match them that way when copying.
  const lookup = new Map<string, string>();
  for (const key of Object.keys(source)) lookup.set(process.platform === 'win32' ? key.toUpperCase() : key, key);
  for (const name of names) {
    if (!isValidEnvName(name) || isDeniedGateEnv(name)) continue;
    const key = lookup.get(process.platform === 'win32' ? name.toUpperCase() : name);
    const value = key === undefined ? undefined : source[key];
    if (value !== undefined) env[key as string] = value;
  }
  for (const [name, value] of Object.entries(opts.set ?? {})) env[name] = value;
  return env;
}
