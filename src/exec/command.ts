/**
 * Spawning commands without a shell. Gate commands from gates.yaml are tokenised into an argv
 * (quotes and backslash escapes supported) so nothing is ever interpolated into a shell string;
 * a gate opts into a shell explicitly with `shell: true`.
 */
import { spawn } from 'node:child_process';
import { buildGateEnv } from './env.js';
import type { CommandExecutor, CommandSpec, ExecOptions, ExecResult } from '../types.js';

/** Split a command line into argv words (POSIX-ish: '', "", backslash escapes). */
export function splitCommand(line: string): string[] {
  const words: string[] = [];
  let current = '';
  let inWord = false;
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i] as string;
    if (quote) {
      if (ch === quote) quote = null;
      else if (ch === '\\' && quote === '"' && i + 1 < line.length) current += line[++i];
      else current += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      inWord = true;
    } else if (ch === '\\' && i + 1 < line.length) {
      current += line[++i];
      inWord = true;
    } else if (/\s/.test(ch)) {
      if (inWord) words.push(current);
      current = '';
      inWord = false;
    } else {
      current += ch;
      inWord = true;
    }
  }
  if (quote) throw new Error(`Unterminated ${quote} quote in command: ${line}`);
  if (inWord) words.push(current);
  return words;
}

/** Build a CommandSpec from a gates.yaml `command` string. */
export function commandFromString(line: string, shell = false): CommandSpec {
  if (shell) return { command: line, args: [], shell: true };
  const [command, ...args] = splitCommand(line);
  if (!command) throw new Error('Empty command');
  return { command, args };
}

export function formatCommand(cmd: CommandSpec): string {
  if (cmd.shell) return cmd.command;
  return [cmd.command, ...cmd.args].map((w) => (/^[\w@%+=:,./-]+$/.test(w) ? w : JSON.stringify(w))).join(' ');
}

const MAX_CAPTURE = 4 * 1024 * 1024;

/**
 * Default executor: `child_process.spawn`, own process group, kill on timeout/abort. The child gets a scrubbed
 * environment (`buildGateEnv`), never `process.env`: gate commands execute agent-written code.
 */
export class SpawnCommandExecutor implements CommandExecutor {
  exec(cmd: CommandSpec, opts: ExecOptions): Promise<ExecResult> {
    const started = Date.now();
    return new Promise<ExecResult>((resolve) => {
      if (opts.signal?.aborted) {
        resolve({ exitCode: null, stdout: '', stderr: '', durationMs: 0, timedOut: false, aborted: true });
        return;
      }
      const child = spawn(cmd.command, cmd.args, {
        cwd: opts.cwd,
        env: buildGateEnv({ allow: opts.passEnv ?? [], set: { CI: '1', FORCE_COLOR: '0', ...opts.env } }),
        shell: cmd.shell ? '/bin/sh' : false,
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: process.platform !== 'win32',
      });
      let stdout = '';
      let stderr = '';
      let timedOut = false;
      let aborted = false;
      let settled = false;
      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');
      child.stdout.on('data', (d: string) => {
        if (stdout.length < MAX_CAPTURE) stdout += d;
      });
      child.stderr.on('data', (d: string) => {
        if (stderr.length < MAX_CAPTURE) stderr += d;
      });
      const kill = () => killTree(child.pid);
      const timer =
        opts.timeoutMs && opts.timeoutMs > 0
          ? setTimeout(() => {
              timedOut = true;
              kill();
            }, opts.timeoutMs)
          : undefined;
      const onAbort = () => {
        aborted = true;
        kill();
      };
      opts.signal?.addEventListener('abort', onAbort, { once: true });
      const finish = (exitCode: number | null, spawnError?: string) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        opts.signal?.removeEventListener('abort', onAbort);
        const result: ExecResult = { exitCode, stdout, stderr, durationMs: Date.now() - started, timedOut };
        if (aborted) result.aborted = true;
        if (spawnError) result.spawnError = spawnError;
        resolve(result);
      };
      child.on('error', (err) => finish(null, err.message));
      child.on('close', (code) => finish(code));
    });
  }
}

export function killTree(pid: number | undefined, signal: NodeJS.Signals = 'SIGTERM'): void {
  if (pid === undefined) return;
  try {
    if (process.platform !== 'win32') process.kill(-pid, signal);
    else process.kill(pid, signal);
  } catch {
    try {
      process.kill(pid, signal);
    } catch {
      /* already gone */
    }
  }
}

/** Last `max` characters of combined output, for GateResult.output. */
export function outputTail(result: Pick<ExecResult, 'stdout' | 'stderr'>, max = 4000): string {
  const combined = [result.stdout.trimEnd(), result.stderr.trimEnd()].filter(Boolean).join('\n');
  return combined.length > max ? `…${combined.slice(-max)}` : combined;
}
