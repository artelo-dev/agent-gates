/**
 * Default GateRunner implementation: runs the requested gates sequentially in
 * the project dir, aggregates a GateReport and writes it to `<artifactsDir>/gates.json`.
 */
import { randomBytes } from 'node:crypto';
import { mkdir, readdir, rm, rmdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { GateContext, GateId, GateReport, GateResult, GateRunner, GatesConfig } from './contracts.js';
import { enabledGates, isRunnableGate, resolveGateConfig, DEFAULT_SERVER_PORT, DEFAULT_SERVER_READY_TIMEOUT_MS } from './config.js';
import { commandFromString, SpawnCommandExecutor } from './exec/command.js';
import { FsToolProbe } from './exec/probe.js';
import { ProcessServerLauncher } from './exec/server.js';
import { axeGate, lighthouseGate, playwrightGate, ServerUnavailableError, visualGate } from './gates/browser/gates.js';
import { buildGate, customCommandGate, eslintGate, testsGate, tscGate } from './gates/command-gates.js';
import { contentLintGate } from './gates/content-lint/gate.js';
import { errored, skipped } from './gates/outcome.js';
import { DEFAULT_GATE_ORDER, normalizeGateId } from './ids.js';
import { detectProject, pathExists, runScriptCommand } from './project.js';
import { aggregateReport, isBlocking, writeGateReport, GATE_REPORT_FILE } from './report.js';
import type { GatePolicy } from './report.js';
import type {
  FullGatesConfig,
  CommandExecutor,
  GateImplementation,
  GateOutcome,
  GateRunContext,
  GateRunnerHooks,
  ProjectInfo,
  ServerHandle,
  ServerLauncher,
  ToolProbe,
} from './types.js';

export const BUILTIN_GATES: readonly GateImplementation[] = [
  tscGate,
  eslintGate,
  buildGate,
  testsGate,
  contentLintGate,
  playwrightGate,
  axeGate,
  visualGate,
  lighthouseGate,
];

export interface GateRunnerOptions extends GateRunnerHooks {
  exec?: CommandExecutor;
  probe?: ToolProbe;
  server?: ServerLauncher;
  /** Extra or replacement gate implementations (matched by id). */
  gates?: readonly GateImplementation[];
  /** Clock (tests). */
  now?: () => Date;
  /** Write `<artifactsDir>/gates.json` (default true). */
  writeReport?: boolean;
  reportFileName?: string;
}

/** Scratch dir for generated Playwright files; must live inside the project so imports resolve. */
const SCRATCH_PARENT = ['.agent-gates', 'tmp'];

export class DefaultGateRunner implements GateRunner {
  private readonly exec: CommandExecutor;
  private readonly probe: ToolProbe;
  private readonly launcher: ServerLauncher;
  private readonly registry = new Map<GateId, GateImplementation>();
  private readonly now: () => Date;

  constructor(private readonly opts: GateRunnerOptions = {}) {
    this.exec = opts.exec ?? new SpawnCommandExecutor();
    this.probe = opts.probe ?? new FsToolProbe();
    this.launcher = opts.server ?? new ProcessServerLauncher();
    this.now = opts.now ?? (() => new Date());
    for (const gate of [...BUILTIN_GATES, ...(opts.gates ?? [])]) this.registry.set(gate.id, gate);
  }

  /**
   * Run `gates` (aliases allowed; empty = every gate enabled in `config`, else all built-ins).
   * Never throws for a gate failure: crashes become `error` results.
   */
  async run(gates: GateId[], config: GatesConfig, ctx: GateContext): Promise<GateReport> {
    const startedAt = this.now().toISOString();
    const fullConfig = config as FullGatesConfig;
    const ids = this.selectGates(gates, config);
    const project = await detectProject(ctx.cwd);
    const session = new RunSession(ctx, fullConfig, project, this.launcher);
    const results: GateResult[] = [];
    const policies: Partial<Record<GateId, GatePolicy>> = {};
    let buildBroken = false;
    try {
      for (const id of ids) {
        const resolved = resolveGateConfig(config, id);
        // A gate switched off in gates.yaml is reported as skipped but never blocks the report.
        policies[id] = { required: resolved.required, allowSkip: resolved.allowSkip || !resolved.enabled };
        const impl = this.registry.get(id) ?? (isRunnableGate(config, id) ? customCommandGate(id) : undefined);
        this.opts.onGateStart?.(id, ctx);
        const started = Date.now();
        let outcome: GateOutcome;
        if (ctx.signal?.aborted) outcome = errored('run aborted before this gate started');
        else if (!resolved.enabled) outcome = skipped('disabled in gates.yaml');
        else if (!impl) outcome = errored(`unknown gate "${id}" (no built-in runner and no command in gates.yaml)`);
        else if (impl.browser && buildBroken) outcome = skipped('blocked: the build gate did not pass');
        else {
          const rc: GateRunContext = {
            gate: id,
            ctx,
            config: resolved,
            fullConfig,
            exec: this.exec,
            probe: this.probe,
            project,
            server: () => session.server(),
            workDir: () => session.workDir(),
          };
          try {
            outcome = await impl.run(rc);
          } catch (err) {
            outcome = errored(`gate crashed: ${(err as Error).message}`);
          }
        }
        if (id === 'build' && (outcome.status === 'failed' || outcome.status === 'error')) buildBroken = true;
        const result: GateResult = { gate: id, ...outcome, durationMs: Date.now() - started };
        result.blocking = isBlocking(result, policies[id]);
        results.push(result);
        this.opts.onGateResult?.(result, ctx);
      }
    } finally {
      await session.close();
    }
    const reportInput: Parameters<typeof aggregateReport>[0] = {
      runId: ctx.runId,
      startedAt,
      finishedAt: this.now().toISOString(),
      results,
      policies,
    };
    if (ctx.taskId !== undefined) reportInput.taskId = ctx.taskId;
    const report = aggregateReport(reportInput);
    if (this.opts.writeReport !== false) {
      await writeGateReport(report, ctx.artifactsDir, this.opts.reportFileName ?? GATE_REPORT_FILE);
    }
    return report;
  }

  private selectGates(gates: GateId[], config: GatesConfig): GateId[] {
    let ids = gates.map(normalizeGateId);
    if (ids.length === 0) {
      const configured = enabledGates(config);
      ids = configured.length > 0 ? configured : [...DEFAULT_GATE_ORDER];
    }
    return ids.filter((id, i) => ids.indexOf(id) === i);
  }
}

/** Per-run shared resources: the preview server and the scratch dir, both torn down in close(). */
class RunSession {
  private serverPromise: Promise<ServerHandle> | undefined;
  private scratch: string | undefined;
  private createdRootDir = false;

  constructor(
    private readonly ctx: GateContext,
    private readonly config: FullGatesConfig,
    private readonly project: ProjectInfo,
    private readonly launcher: ServerLauncher,
  ) {}

  server(): Promise<ServerHandle> {
    this.serverPromise ??= this.startServer();
    return this.serverPromise;
  }

  private async startServer(): Promise<ServerHandle> {
    const sc = this.config.server ?? {};
    const port = sc.port ?? DEFAULT_SERVER_PORT;
    const url = sc.url ?? `http://127.0.0.1:${port}`;
    const command = sc.command
      ? commandFromString(sc.command, sc.shell === true)
      : sc.url
        ? undefined
        : this.project.scripts.start
          ? runScriptCommand(this.project, 'start')
          : undefined;
    if (!command && !sc.url) {
      throw new ServerUnavailableError('no preview server: set server.command or server.url in gates.yaml, or add a "start" script');
    }
    const opts: Parameters<ServerLauncher['start']>[0] = {
      cwd: this.ctx.cwd,
      url,
      port,
      readyTimeoutMs: sc.readyTimeoutMs ?? DEFAULT_SERVER_READY_TIMEOUT_MS,
    };
    if (command) opts.command = command;
    if (this.ctx.signal) opts.signal = this.ctx.signal;
    if (this.config.env?.length) opts.passEnv = this.config.env;
    return this.launcher.start(opts);
  }

  async workDir(): Promise<string> {
    if (this.scratch) return this.scratch;
    const rootDir = join(this.ctx.cwd, SCRATCH_PARENT[0] as string);
    this.createdRootDir = !(await pathExists(rootDir));
    const dir = join(this.ctx.cwd, ...SCRATCH_PARENT, `${this.ctx.runId.replace(/[^\w-]/g, '_')}-${randomBytes(4).toString('hex')}`);
    await mkdir(dir, { recursive: true });
    this.scratch = dir;
    return dir;
  }

  async close(): Promise<void> {
    if (this.serverPromise) {
      try {
        await (await this.serverPromise).stop();
      } catch {
        /* failed to start: nothing to stop */
      }
    }
    if (this.scratch) {
      await rm(this.scratch, { recursive: true, force: true });
      await removeIfEmpty(join(this.ctx.cwd, ...SCRATCH_PARENT));
      if (this.createdRootDir) await removeIfEmpty(join(this.ctx.cwd, SCRATCH_PARENT[0] as string));
    }
  }
}

async function removeIfEmpty(dir: string): Promise<void> {
  try {
    if ((await readdir(dir)).length === 0) await rmdir(dir);
  } catch {
    /* missing or not empty */
  }
}

export function createGateRunner(opts: GateRunnerOptions = {}): DefaultGateRunner {
  return new DefaultGateRunner(opts);
}
