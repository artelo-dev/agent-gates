/** Test helpers: temp project dirs, fake executor/probe/server. Nothing here spawns real tools. */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { CommandExecutor, CommandSpec, ExecOptions, ExecResult, ServerHandle, ServerLauncher, ServerStartOptions, ToolProbe } from '../src/index.js';

export async function makeTempDir(prefix = 'agent-gates-test-'): Promise<{ dir: string; cleanup: () => Promise<void> }> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  return { dir, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

export async function writeFiles(root: string, files: Record<string, string>): Promise<void> {
  for (const [rel, content] of Object.entries(files)) {
    const path = join(root, rel);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, content);
  }
}

export interface RecordedCall {
  cmd: CommandSpec;
  opts: ExecOptions;
}

type Handler = (cmd: CommandSpec, opts: ExecOptions) => Partial<ExecResult> | Promise<Partial<ExecResult>>;

/** Fake executor: routes calls to handlers by a predicate on the argv, records every call. */
export class FakeExecutor implements CommandExecutor {
  readonly calls: RecordedCall[] = [];
  private readonly routes: Array<{ match: (argv: string) => boolean; handler: Handler }> = [];

  on(match: string | RegExp | ((argv: string) => boolean), handler: Handler): this {
    const fn = typeof match === 'function' ? match : typeof match === 'string' ? (a: string) => a.includes(match) : (a: string) => match.test(a);
    this.routes.push({ match: fn, handler });
    return this;
  }

  async exec(cmd: CommandSpec, opts: ExecOptions): Promise<ExecResult> {
    this.calls.push({ cmd, opts });
    const argv = [cmd.command, ...cmd.args].join(' ');
    const route = this.routes.find((r) => r.match(argv));
    const partial = route ? await route.handler(cmd, opts) : { exitCode: 0 };
    return { exitCode: 0, stdout: '', stderr: '', durationMs: 1, timedOut: false, ...partial };
  }

  argvs(): string[] {
    return this.calls.map((c) => [c.cmd.command, ...c.cmd.args].join(' '));
  }
}

export class FakeProbe implements ToolProbe {
  constructor(
    private readonly bins: Record<string, string> = {},
    private readonly modules: string[] = [],
  ) {}
  async findBin(name: string): Promise<string | undefined> {
    return this.bins[name];
  }
  async hasModule(name: string): Promise<boolean> {
    return this.modules.includes(name);
  }
}

export class FakeServer implements ServerLauncher {
  starts: ServerStartOptions[] = [];
  stops = 0;
  constructor(private readonly fail?: string) {}
  async start(opts: ServerStartOptions): Promise<ServerHandle> {
    this.starts.push(opts);
    if (this.fail) throw new Error(this.fail);
    return {
      url: opts.url,
      stop: async () => {
        this.stops++;
      },
    };
  }
}

/** Value of `--flag=value` or `--flag value` in an argv. */
export function argValue(args: string[], flag: string): string | undefined {
  for (let i = 0; i < args.length; i++) {
    const a = args[i] as string;
    if (a === flag) return args[i + 1];
    if (a.startsWith(`${flag}=`)) return a.slice(flag.length + 1);
  }
  return undefined;
}
