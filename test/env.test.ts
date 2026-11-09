/**
 * Regression: gate commands and the preview server run agent-written code (package.json scripts, next/eslint/playwright
 * configs), so they must never inherit the developer's secrets from process.env.
 */
import { createServer } from 'node:net';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  BASE_GATE_ENV,
  buildGateEnv,
  createGateRunner,
  GatesConfigError,
  isDeniedGateEnv,
  parseGatesConfig,
  ProcessServerLauncher,
  SpawnCommandExecutor,
} from '../src/index.js';
import type { FullGatesConfig, GateImplementation } from '../src/index.js';
import { FakeExecutor, FakeProbe, FakeServer, makeTempDir, writeFiles } from './helpers.js';

const node = process.execPath;

const SECRETS: Record<string, string> = {
  VERCEL_TOKEN: 'vercel-secret',
  ANTHROPIC_API_KEY: 'sk-ant-secret',
  OPENAI_API_KEY: 'sk-openai-secret',
  CLAUDE_CODE_OAUTH_TOKEN: 'claude-secret',
  GEMINI_API_KEY: 'gemini-secret',
  GITHUB_TOKEN: 'gh-secret',
  ARTELO_TEST_UNLISTED: 'unlisted-secret',
};
const ALLOWED = { ARTELO_TEST_ALLOWED: 'allowed-value' };

let saved: Record<string, string | undefined>;
beforeEach(() => {
  saved = {};
  for (const [k, v] of Object.entries({ ...SECRETS, ...ALLOWED })) {
    saved[k] = process.env[k];
    process.env[k] = v;
  }
});
afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

const DUMP_ENV = 'process.stdout.write(JSON.stringify(process.env))';

function expectNoSecrets(env: Record<string, unknown>): void {
  for (const name of Object.keys(SECRETS)) expect(env[name], name).toBeUndefined();
  const values = Object.values(env).map(String);
  for (const secret of Object.values(SECRETS)) expect(values).not.toContain(secret);
}

describe('buildGateEnv', () => {
  const source = { PATH: '/bin', HOME: '/home/dev', LANG: 'en_US.UTF-8', SHELL: '/bin/zsh', ...SECRETS, ...ALLOWED };

  it('keeps only the base allowlist from the parent environment', () => {
    const env = buildGateEnv({ source });
    expect(env).toEqual({ PATH: '/bin', HOME: '/home/dev', LANG: 'en_US.UTF-8' });
    expect(BASE_GATE_ENV).toEqual(expect.arrayContaining(['PATH', 'HOME', 'TMPDIR', 'LANG', 'CI', 'NODE_ENV', 'PORT']));
  });

  it('forwards names gates.yaml lists, but never deploy tokens or LLM keys', () => {
    const env = buildGateEnv({ source, allow: ['ARTELO_TEST_ALLOWED', 'VERCEL_TOKEN', 'anthropic_api_key', 'NOT SET', 'MISSING'] });
    expect(env.ARTELO_TEST_ALLOWED).toBe('allowed-value');
    expectNoSecrets(env);
    expect('MISSING' in env).toBe(false);
  });

  it('applies Artelo-set values last', () => {
    expect(buildGateEnv({ source, set: { CI: '1', PORT: '3100' } })).toMatchObject({ CI: '1', PORT: '3100', PATH: '/bin' });
  });

  it('classifies credentials', () => {
    for (const name of Object.keys(SECRETS).filter((n) => n !== 'ARTELO_TEST_UNLISTED')) expect(isDeniedGateEnv(name), name).toBe(true);
    for (const name of ['PATH', 'NEXT_PUBLIC_SITE_URL', 'ARTELO_TEST_ALLOWED']) expect(isDeniedGateEnv(name), name).toBe(false);
  });
});

describe('SpawnCommandExecutor env scrubbing', () => {
  const exec = new SpawnCommandExecutor();

  it('does not leak process.env secrets to gate commands', async () => {
    const res = await exec.exec({ command: node, args: ['-e', DUMP_ENV] }, { cwd: process.cwd(), env: { EXTRA: 'x' } });
    expect(res.exitCode).toBe(0);
    const env = JSON.parse(res.stdout) as Record<string, string>;
    expectNoSecrets(env);
    expect(env.ARTELO_TEST_ALLOWED).toBeUndefined();
    expect(env).toMatchObject({ CI: '1', FORCE_COLOR: '0', EXTRA: 'x', PATH: process.env.PATH });
  });

  it('forwards passEnv names and still drops credentials named there', async () => {
    const res = await exec.exec(
      { command: node, args: ['-e', DUMP_ENV] },
      { cwd: process.cwd(), passEnv: ['ARTELO_TEST_ALLOWED', 'VERCEL_TOKEN', 'ANTHROPIC_API_KEY'] },
    );
    const env = JSON.parse(res.stdout) as Record<string, string>;
    expect(env.ARTELO_TEST_ALLOWED).toBe('allowed-value');
    expectNoSecrets(env);
  });

  it('scrubs shell commands too', async () => {
    const res = await exec.exec({ command: `"${node}" -e '${DUMP_ENV}'`, args: [], shell: true }, { cwd: process.cwd() });
    expectNoSecrets(JSON.parse(res.stdout) as Record<string, string>);
  });
});

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      srv.close(() => resolve(port));
    });
  });
}

describe('ProcessServerLauncher env scrubbing', () => {
  it('starts the serve command without process.env secrets', async () => {
    const port = await freePort();
    const script =
      "require('http').createServer((q, s) => s.end(JSON.stringify(process.env))).listen(Number(process.env.PORT), '127.0.0.1')";
    const handle = await new ProcessServerLauncher().start({
      cwd: process.cwd(),
      url: `http://127.0.0.1:${port}`,
      port,
      command: { command: node, args: ['-e', script] },
      readyTimeoutMs: 10_000,
      passEnv: ['ARTELO_TEST_ALLOWED', 'VERCEL_TOKEN'],
    });
    try {
      const env = (await (await fetch(handle.url)).json()) as Record<string, string>;
      expectNoSecrets(env);
      expect(env).toMatchObject({ PORT: String(port), NODE_ENV: 'production', ARTELO_TEST_ALLOWED: 'allowed-value' });
    } finally {
      await handle.stop();
    }
  });
});

describe('gates.yaml env allowlist', () => {
  it('parses a list of names', () => {
    expect(parseGatesConfig({ gates: {}, env: ['NEXT_PUBLIC_SITE_URL', 'NEXT_PUBLIC_SITE_URL', 'SENTRY_DSN'] }).env).toEqual([
      'NEXT_PUBLIC_SITE_URL',
      'SENTRY_DSN',
    ]);
    expect(parseGatesConfig({ gates: {} }).env).toBeUndefined();
  });

  it('rejects credentials and invalid names', () => {
    let error: GatesConfigError | undefined;
    try {
      parseGatesConfig({ gates: {}, env: ['VERCEL_TOKEN', 'OPENAI_API_KEY', 'bad-name'] });
    } catch (err) {
      error = err as GatesConfigError;
    }
    expect(error).toBeInstanceOf(GatesConfigError);
    expect(error?.problems).toEqual([
      expect.stringMatching(/VERCEL_TOKEN is a deploy token/),
      expect.stringMatching(/OPENAI_API_KEY is a deploy token/),
      expect.stringMatching(/invalid variable name "bad-name"/),
    ]);
    expect(() => parseGatesConfig({ gates: {}, env: 'PATH' })).toThrow(/env: must be a list/);
  });

  it('threads the allowlist to gate commands and the preview server', async () => {
    const tmp = await makeTempDir();
    try {
      const dir = join(tmp.dir, 'project');
      await writeFiles(dir, { 'package.json': JSON.stringify({ scripts: { build: 'next build', start: 'next start' } }) });
      const exec = new FakeExecutor();
      const server = new FakeServer();
      const config: FullGatesConfig = { env: ['ARTELO_TEST_ALLOWED'], gates: { build: {}, 'needs-server': {} } };
      const needsServer: GateImplementation = {
        id: 'needs-server',
        browser: true,
        run: async (rc) => {
          await rc.server();
          return { status: 'passed', summary: 'ok', issues: [] };
        },
      };
      const runner = createGateRunner({ exec, probe: new FakeProbe(), server, writeReport: false, gates: [needsServer] });
      await runner.run(['build'], config, { runId: 'r', cwd: dir, artifactsDir: join(dir, '.artelo', 'runs', 'r') });
      expect(exec.calls.length).toBeGreaterThan(0);
      for (const call of exec.calls) expect(call.opts.passEnv).toEqual(['ARTELO_TEST_ALLOWED']);

      await runner.run(['needs-server'], config, { runId: 'r2', cwd: dir, artifactsDir: join(dir, '.artelo', 'runs', 'r2') });
      expect(server.starts.at(-1)?.passEnv).toEqual(['ARTELO_TEST_ALLOWED']);
    } finally {
      await tmp.cleanup();
    }
  });
});
