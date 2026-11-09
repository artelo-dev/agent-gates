/**
 * Preview server for browser gates. Starts the project's serve command (if any), waits until the
 * base URL answers, and kills the whole process group on stop. Only ever talks to the local URL
 * from gates.yaml (default http://127.0.0.1:3100).
 */
import { spawn } from 'node:child_process';
import { killTree } from './command.js';
import { buildGateEnv } from './env.js';
import type { ServerHandle, ServerLauncher, ServerStartOptions } from '../types.js';

const POLL_MS = 250;

export async function waitForUrl(url: string, timeoutMs: number, signal?: AbortSignal, isDead?: () => string | undefined): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError = 'no response';
  while (Date.now() < deadline) {
    if (signal?.aborted) throw new Error('aborted');
    const dead = isDead?.();
    if (dead) throw new Error(dead);
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(5_000), redirect: 'manual' });
      await res.body?.cancel();
      if (res.status < 500) return;
      lastError = `HTTP ${res.status}`;
    } catch (err) {
      lastError = (err as Error).message;
    }
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
  throw new Error(`${url} not ready after ${timeoutMs}ms (${lastError})`);
}

export class ProcessServerLauncher implements ServerLauncher {
  async start(opts: ServerStartOptions): Promise<ServerHandle> {
    const url = opts.url.replace(/\/+$/, '');
    if (!opts.command) {
      await waitForUrl(url, opts.readyTimeoutMs, opts.signal);
      return { url, stop: async () => {} };
    }
    const cmd = opts.command;
    const child = spawn(cmd.command, cmd.args, {
      cwd: opts.cwd,
      // Scrubbed env: the serve command (`next start`, next.config.ts, ...) is agent-written code.
      env: buildGateEnv({ allow: opts.passEnv ?? [], set: { PORT: String(opts.port), NODE_ENV: 'production', FORCE_COLOR: '0' } }),
      shell: cmd.shell ? '/bin/sh' : false,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
    });
    let log = '';
    const capture = (d: Buffer) => {
      log = (log + d.toString('utf8')).slice(-4000);
    };
    child.stdout.on('data', capture);
    child.stderr.on('data', capture);
    let exitInfo: string | undefined;
    child.on('error', (err) => {
      exitInfo = `server failed to start: ${err.message}`;
    });
    child.on('exit', (code, sig) => {
      exitInfo ??= `server exited early (code ${code ?? sig})\n${log}`;
    });
    const stop = async () => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      const exited = new Promise<void>((r) => child.once('exit', () => r()));
      killTree(child.pid, 'SIGTERM');
      const timeout = new Promise<'timeout'>((r) => setTimeout(() => r('timeout'), 5_000).unref());
      if ((await Promise.race([exited, timeout])) === 'timeout') killTree(child.pid, 'SIGKILL');
    };
    try {
      await waitForUrl(url, opts.readyTimeoutMs, opts.signal, () => exitInfo);
    } catch (err) {
      await stop();
      throw err;
    }
    return { url, stop };
  }
}
