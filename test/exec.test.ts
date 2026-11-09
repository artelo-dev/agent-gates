import { chmod } from 'node:fs/promises';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { FsToolProbe, ProcessServerLauncher, SpawnCommandExecutor, commandFromString, detectProject, findUp, formatCommand, outputTail, splitCommand } from '../src/index.js';
import { makeTempDir, writeFiles } from './helpers.js';

const node = process.execPath;

describe('splitCommand', () => {
  it('tokenises quotes and escapes without a shell', () => {
    expect(splitCommand('pnpm exec tsc --noEmit')).toEqual(['pnpm', 'exec', 'tsc', '--noEmit']);
    expect(splitCommand(`run "two words" 'single $HOME' a\\ b ""`)).toEqual(['run', 'two words', 'single $HOME', 'a b', '']);
    expect(() => splitCommand('echo "oops')).toThrow(/Unterminated/);
    expect(commandFromString('a && b', true)).toEqual({ command: 'a && b', args: [], shell: true });
    expect(formatCommand({ command: 'npm', args: ['run', 'two words'] })).toBe('npm run "two words"');
  });

  it('keeps the tail of long output', () => {
    expect(outputTail({ stdout: 'x'.repeat(10), stderr: 'err' }, 5)).toBe('…x\nerr');
  });
});

describe('SpawnCommandExecutor', () => {
  const exec = new SpawnCommandExecutor();

  it('captures stdout, stderr and the exit code', async () => {
    const res = await exec.exec({ command: node, args: ['-e', 'console.log("out"); console.error("err"); process.exit(3)'] }, { cwd: process.cwd() });
    expect(res).toMatchObject({ exitCode: 3, stdout: 'out\n', stderr: 'err\n', timedOut: false });
  });

  it('passes env and cwd', async () => {
    const tmp = await makeTempDir();
    try {
      const res = await exec.exec({ command: node, args: ['-e', 'console.log(process.env.ARTELO_X + ":" + process.cwd())'] }, { cwd: tmp.dir, env: { ARTELO_X: 'yes' } });
      expect(res.stdout.trim()).toMatch(/^yes:.*agent-gates-test-/);
    } finally {
      await tmp.cleanup();
    }
  });

  it('kills the process on timeout and on abort', async () => {
    const timed = await exec.exec({ command: node, args: ['-e', 'setTimeout(() => {}, 60000)'] }, { cwd: process.cwd(), timeoutMs: 200 });
    expect(timed.timedOut).toBe(true);
    expect(timed.durationMs).toBeLessThan(5000);

    const controller = new AbortController();
    setTimeout(() => controller.abort(), 100);
    const aborted = await exec.exec({ command: node, args: ['-e', 'setTimeout(() => {}, 60000)'] }, { cwd: process.cwd(), signal: controller.signal });
    expect(aborted.aborted).toBe(true);
  });

  it('reports spawn errors instead of throwing', async () => {
    const res = await exec.exec({ command: 'artelo-definitely-not-a-binary', args: [] }, { cwd: process.cwd() });
    expect(res.exitCode).toBeNull();
    expect(res.spawnError).toMatch(/ENOENT/);
  });
});

describe('FsToolProbe and detectProject', () => {
  let cleanup: (() => Promise<void>) | undefined;
  afterEach(async () => {
    await cleanup?.();
    cleanup = undefined;
  });

  it('finds local bins in ancestor node_modules and resolvable packages', async () => {
    const tmp = await makeTempDir();
    cleanup = tmp.cleanup;
    await writeFiles(tmp.dir, {
      'node_modules/.bin/lighthouse': '#!/bin/sh\n',
      'node_modules/@axe-core/playwright/package.json': '{"name":"@axe-core/playwright","version":"1.0.0"}',
      'app/package.json': '{}',
    });
    await chmod(join(tmp.dir, 'node_modules/.bin/lighthouse'), 0o755);
    const probe = new FsToolProbe('');
    expect(await probe.findBin('lighthouse', join(tmp.dir, 'app'))).toBe(join(tmp.dir, 'node_modules/.bin/lighthouse'));
    expect(await probe.findBin('nope', tmp.dir)).toBeUndefined();
    expect(await probe.hasModule('@axe-core/playwright', join(tmp.dir, 'app'))).toBe(true);
    expect(await probe.hasModule('@playwright/test', join(tmp.dir, 'app'))).toBe(false);
  });

  it('findUp searches ancestors but stops at the git root', async () => {
    const tmp = await makeTempDir();
    cleanup = tmp.cleanup;
    await writeFiles(tmp.dir, {
      'eslint.config.js': '',
      'repo/.git/HEAD': '',
      'repo/packages/a/package.json': '{}',
      'mono/eslint.config.mjs': '',
      'mono/.git/HEAD': '',
      'mono/packages/b/package.json': '{}',
    });
    expect(await findUp(join(tmp.dir, 'repo/packages/a'), ['eslint.config.js'])).toBeUndefined();
    expect(await findUp(join(tmp.dir, 'mono/packages/b'), ['eslint.config.js', 'eslint.config.mjs'])).toBe(join(tmp.dir, 'mono/eslint.config.mjs'));
  });

  it('detects the package manager and scripts', async () => {
    const tmp = await makeTempDir();
    cleanup = tmp.cleanup;
    await writeFiles(tmp.dir, { 'yarn.lock': '', 'package.json': JSON.stringify({ scripts: { build: 'next build', bad: 1 } }) });
    expect(await detectProject(tmp.dir)).toEqual({ cwd: tmp.dir, packageManager: 'yarn', scripts: { build: 'next build' }, hasPackageJson: true });
    await writeFiles(tmp.dir, { 'package.json': JSON.stringify({ packageManager: 'pnpm@11.0.0' }) });
    expect((await detectProject(tmp.dir)).packageManager).toBe('pnpm');
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

describe('ProcessServerLauncher (local child process on 127.0.0.1)', () => {
  it('starts the serve command with PORT, waits until ready and stops it', async () => {
    const port = await freePort();
    const launcher = new ProcessServerLauncher();
    const script = "require('http').createServer((q, s) => s.end('ok')).listen(Number(process.env.PORT), '127.0.0.1')";
    const handle = await launcher.start({
      cwd: process.cwd(),
      url: `http://127.0.0.1:${port}/`,
      port,
      command: { command: node, args: ['-e', script] },
      readyTimeoutMs: 10_000,
    });
    expect(handle.url).toBe(`http://127.0.0.1:${port}`);
    expect(await (await fetch(handle.url)).text()).toBe('ok');
    await handle.stop();
    await expect(fetch(handle.url)).rejects.toThrow();
  });

  it('fails fast when the server process exits', async () => {
    const port = await freePort();
    await expect(
      new ProcessServerLauncher().start({
        cwd: process.cwd(),
        url: `http://127.0.0.1:${port}`,
        port,
        command: { command: node, args: ['-e', 'console.error("boom"); process.exit(1)'] },
        readyTimeoutMs: 10_000,
      }),
    ).rejects.toThrow(/exited early[\s\S]*boom/);
  });
});
