/** Load config (or detect gates), run them, return the report. Shared by `run` and `hook`. */
import { readFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { loadGatesConfig } from '../config.js';
import type { GateId, GateReport, GateResult, Spec } from '../contracts.js';
import { normalizeGateId } from '../ids.js';
import { createGateRunner } from '../runner.js';
import type { FullGatesConfig } from '../types.js';
import { firstExisting, pathExists } from '../project.js';
import { CONFIG_FILES, autoConfig, detectGates } from './detect.js';

export const STATE_DIR = '.agent-gates';
export const DEFAULT_OUT_DIR = join(STATE_DIR, 'last');

export interface RunOptions {
  cwd: string;
  /** Gate ids or aliases; empty = every gate in the config. */
  gates?: string[];
  /** Explicit config path (relative to cwd). */
  configPath?: string;
  /** Spec file for the playwright smoke gate. */
  specPath?: string;
  /** Artifacts dir (relative to cwd). Default `.agent-gates/last`. */
  outDir?: string;
  signal?: AbortSignal;
  /** Stop at the first failing gate (the hook's default). */
  failFast?: boolean;
  onGateStart?: (gate: GateId) => void;
  onGateResult?: (result: GateResult) => void;
}

export interface LoadedConfig {
  config: FullGatesConfig;
  /** Config file used, relative to cwd; undefined in auto mode. */
  source?: string;
}

export class CliError extends Error {}

/**
 * The project a hook should check when the agent may be sitting in a subdirectory: walk up from
 * `start` to the nearest agent-gates.yaml, else the nearest package.json, never past the git root.
 */
export async function findProjectRoot(start: string): Promise<string> {
  let dir = resolve(start);
  let pkgDir: string | undefined;
  for (;;) {
    if (await firstExisting(dir, CONFIG_FILES)) return dir;
    if (!pkgDir && (await pathExists(join(dir, 'package.json')))) pkgDir = dir;
    const parent = dirname(dir);
    if ((await pathExists(join(dir, '.git'))) || parent === dir) return pkgDir ?? dir;
    dir = parent;
  }
}

export async function loadConfig(cwd: string, configPath?: string): Promise<LoadedConfig> {
  if (configPath) {
    const abs = resolve(cwd, configPath);
    try {
      await readFile(abs);
    } catch {
      throw new CliError(`config file not found: ${configPath}`);
    }
    return { config: await loadGatesConfig(abs), source: relative(cwd, abs) };
  }
  const found = await firstExisting(cwd, CONFIG_FILES);
  if (found) return { config: await loadGatesConfig(join(cwd, found)), source: found };
  return { config: autoConfig(await detectGates(cwd)) };
}

async function loadSpec(cwd: string, specPath: string): Promise<Spec> {
  let doc: unknown;
  try {
    doc = parseYaml(await readFile(resolve(cwd, specPath), 'utf8'));
  } catch (err) {
    throw new CliError(`cannot read spec ${specPath}: ${(err as Error).message}`);
  }
  if (!doc || typeof doc !== 'object' || !Array.isArray((doc as Spec).pages)) {
    throw new CliError(`spec ${specPath} has no "pages" list`);
  }
  return doc as Spec;
}

export interface RunOutcome {
  report: GateReport;
  loaded: LoadedConfig;
  /** Report file, relative to cwd. */
  reportPath: string;
}

export async function runGates(opts: RunOptions): Promise<RunOutcome> {
  const loaded = await loadConfig(opts.cwd, opts.configPath);
  const outDir = opts.outDir ?? DEFAULT_OUT_DIR;
  const ctx: Parameters<ReturnType<typeof createGateRunner>['run']>[2] = {
    runId: `run-${new Date().toISOString().replace(/[:.]/g, '-')}`,
    cwd: opts.cwd,
    artifactsDir: resolve(opts.cwd, outDir),
  };
  if (opts.specPath) {
    ctx.spec = await loadSpec(opts.cwd, opts.specPath);
    // Asking for a spec means asking for the smoke test.
    loaded.config.gates.playwright ??= { required: true, allowSkip: false };
  }
  if (opts.signal) ctx.signal = opts.signal;
  const gates = (opts.gates ?? []).map(normalizeGateId);
  if (gates.length === 0 && Object.keys(loaded.config.gates).length === 0) {
    throw new CliError('no gates to run: none detected and none configured (run `agent-gates init`)');
  }
  const hooks: Parameters<typeof createGateRunner>[0] = {};
  if (opts.failFast) hooks.failFast = true;
  if (opts.onGateStart) hooks.onGateStart = (gate) => opts.onGateStart?.(gate);
  if (opts.onGateResult) hooks.onGateResult = (result) => opts.onGateResult?.(result);
  const report = await createGateRunner(hooks).run(gates, loaded.config, ctx);
  return { report, loaded, reportPath: join(outDir, 'gates.json') };
}
