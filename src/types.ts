/**
 * Internal types of agent-gates. Public contracts (GateResult, GateReport, GatesConfig, ...)
 * live in contracts.ts; everything here is an implementation detail of the runners or an
 * additive extension of `gates.yaml` that core does not need to know about.
 */
import type { GateConfig, GateContext, GateId, GateResult, GatesConfig } from './contracts.js';

// ---------------------------------------------------------------------------
// Command execution (injectable so tests never spawn real tools)
// ---------------------------------------------------------------------------

export interface CommandSpec {
  /** Executable (resolved via PATH by the default executor). */
  command: string;
  args: string[];
  /** Run through `/bin/sh -c` (only for commands the user wrote with `shell: true`). */
  shell?: boolean;
}

export interface ExecOptions {
  cwd: string;
  /** Variables agent-gates sets for this command (trusted values, applied over the scrubbed base env). */
  env?: Record<string, string>;
  /**
   * Extra variable names forwarded from the parent environment (gates.yaml `env:`). The child never inherits
   * `process.env` wholesale: see `buildGateEnv` (exec/env.ts). Deploy tokens / LLM keys are dropped regardless.
   */
  passEnv?: readonly string[];
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface ExecResult {
  /** Process exit code; `null` when killed by a signal or it never started. */
  exitCode: number | null;
  stdout: string;
  stderr: string;
  durationMs: number;
  timedOut: boolean;
  aborted?: boolean;
  /** Set when the process could not be started at all (e.g. ENOENT). */
  spawnError?: string;
}

/** Runs one command to completion. */
export interface CommandExecutor {
  exec(cmd: CommandSpec, opts: ExecOptions): Promise<ExecResult>;
}

// ---------------------------------------------------------------------------
// Tool availability probing (injectable)
// ---------------------------------------------------------------------------

export interface ToolProbe {
  /** Absolute path of an executable: `<dir>/node_modules/.bin/<name>` for cwd and its ancestors, then PATH. */
  findBin(name: string, cwd: string): Promise<string | undefined>;
  /** Whether a package (e.g. `@playwright/test`) is resolvable from `cwd`. */
  hasModule(name: string, cwd: string): Promise<boolean>;
}

// ---------------------------------------------------------------------------
// Preview server for browser gates (playwright, axe, visual, lighthouse)
// ---------------------------------------------------------------------------

/** Top-level `server:` block of gates.yaml (extension of the core GatesConfig contract). */
export interface ServerConfig {
  /** Command that serves the built app, e.g. `pnpm start`. Omit when `url` is already running. */
  command?: string;
  /** Base URL browser gates hit. Default `http://127.0.0.1:<port>`. */
  url?: string;
  /** Exported as `PORT` to the server process. Default 3100. */
  port?: number;
  /** How long to wait for the URL to answer. Default 60s. */
  readyTimeoutMs?: number;
  /** Run `command` through a shell. */
  shell?: boolean;
}

export interface ServerHandle {
  /** Base URL without trailing slash. */
  url: string;
  stop(): Promise<void>;
}

export interface ServerStartOptions {
  cwd: string;
  url: string;
  port: number;
  command?: CommandSpec;
  readyTimeoutMs: number;
  signal?: AbortSignal;
  /** Extra variable names forwarded from the parent environment (gates.yaml `env:`); see `buildGateEnv`. */
  passEnv?: readonly string[];
}

export interface ServerLauncher {
  start(opts: ServerStartOptions): Promise<ServerHandle>;
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

/** Full gates.yaml: `GatesConfig` plus the optional `server` and `env` blocks. */
export interface FullGatesConfig extends GatesConfig {
  server?: ServerConfig;
  /**
   * Allowlist of parent-environment variable NAMES forwarded to gate commands and the preview server, on top of
   * the base set (PATH, HOME, TMPDIR, LANG, CI, NODE_ENV, PORT, ...). Gates run agent-written code, so nothing
   * else is inherited; deploy tokens and LLM keys are rejected even when listed here.
   */
  env?: string[];
}

/**
 * Per-gate config after defaults are applied. Known extra keys (all optional in YAML):
 * - `allowSkip` (default false): a `skipped` result fails the report unless this is true. A gate disabled
 *   in gates.yaml (`enabled: false`) never blocks.
 * - `shell`: run `command` through a shell.
 * - `routes`: routes for browser gates (default: spec page routes, else `/`).
 * - `include` / `exclude`: globs for content-lint.
 */
export interface ResolvedGateConfig extends GateConfig {
  enabled: boolean;
  required: boolean;
  allowSkip: boolean;
  timeoutMs: number;
  thresholds: Record<string, number>;
}

// ---------------------------------------------------------------------------
// Gate implementations
// ---------------------------------------------------------------------------

/** What a gate implementation returns; the runner adds `gate` and `durationMs`. */
export type GateOutcome = Omit<GateResult, 'gate' | 'durationMs'>;

export interface ProjectInfo {
  cwd: string;
  packageManager: 'pnpm' | 'npm' | 'yarn' | 'bun';
  scripts: Record<string, string>;
  hasPackageJson: boolean;
}

export interface GateRunContext {
  gate: GateId;
  ctx: GateContext;
  config: ResolvedGateConfig;
  fullConfig: FullGatesConfig;
  exec: CommandExecutor;
  probe: ToolProbe;
  project: ProjectInfo;
  /** Lazily started shared preview server (browser gates only). */
  server: () => Promise<ServerHandle>;
  /** Scratch dir inside the project for generated files (removed after the run). */
  workDir: () => Promise<string>;
}

export interface GateImplementation {
  id: GateId;
  /** Needs the preview server + a successful build. */
  browser?: boolean;
  run(rc: GateRunContext): Promise<GateOutcome>;
}

/** Progress hooks so the cli can forward per-gate events to the orchestrator stream. */
export interface GateRunnerHooks {
  onGateStart?: (gate: GateId, ctx: GateContext) => void;
  onGateResult?: (result: GateResult, ctx: GateContext) => void;
}
