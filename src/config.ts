/**
 * gates.yaml loading, validation and defaults.
 *
 * Defaults: tsc/eslint 0 errors, build succeeds, Playwright smoke has
 * 0 failures, Lighthouse mobile perf >= 90 / a11y >= 95 / SEO >= 95, axe 0 critical/serious,
 * content-lint 0 findings, screenshots at 375/768/1440.
 */
import { readFile } from 'node:fs/promises';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import type { GateConfig, GateId, GatesConfig } from './contracts.js';
import { isDeniedGateEnv, isValidEnvName } from './exec/env.js';
import { isBuiltinGate, normalizeGateId } from './ids.js';
import type { FullGatesConfig, ResolvedGateConfig, ServerConfig } from './types.js';

export const AXE_IMPACTS = ['critical', 'serious', 'moderate', 'minor'] as const;
export type AxeImpact = (typeof AXE_IMPACTS)[number];

export const DEFAULT_SERVER_PORT = 3100;
export const DEFAULT_SERVER_READY_TIMEOUT_MS = 60_000;
const MINUTE = 60_000;

/** Built-in per-gate defaults (merged under whatever gates.yaml says). */
export const DEFAULT_GATE_SETTINGS: Readonly<Record<string, GateConfig>> = {
  tsc: { thresholds: { errors: 0 }, timeoutMs: 5 * MINUTE },
  eslint: { thresholds: { errors: 0 }, timeoutMs: 5 * MINUTE },
  build: { timeoutMs: 10 * MINUTE },
  tests: { timeoutMs: 10 * MINUTE },
  'content-lint': { thresholds: { errors: 0 }, timeoutMs: 2 * MINUTE },
  playwright: { thresholds: { failures: 0 }, timeoutMs: 5 * MINUTE },
  axe: { failOn: ['critical', 'serious'], timeoutMs: 5 * MINUTE },
  visual: { viewports: [375, 768, 1440], thresholds: { horizontalOverflow: 0 }, timeoutMs: 5 * MINUTE },
  lighthouse: { thresholds: { performance: 90, accessibility: 95, seo: 95 }, timeoutMs: 4 * MINUTE },
};

const FALLBACK_TIMEOUT_MS = 10 * MINUTE;

/**
 * The landing recipe's gates.yaml, as data. `presets/landing.gates.yaml` is the same file on disk.
 * Every gate is blocking (`allowSkip: false`): a missing tool or browser fails the report, never passes it.
 */
export const DEFAULT_GATES_CONFIG: FullGatesConfig = {
  server: { port: DEFAULT_SERVER_PORT, readyTimeoutMs: DEFAULT_SERVER_READY_TIMEOUT_MS },
  gates: {
    tsc: { required: true, allowSkip: false, thresholds: { errors: 0 } },
    eslint: { required: true, allowSkip: false, thresholds: { errors: 0 } },
    'content-lint': { required: true, allowSkip: false, thresholds: { errors: 0 } },
    build: { required: true, allowSkip: false },
    tests: { required: true, allowSkip: false },
    playwright: { required: true, allowSkip: false, thresholds: { failures: 0 } },
    axe: { required: true, allowSkip: false, failOn: ['critical', 'serious'] },
    lighthouse: { required: true, allowSkip: false, thresholds: { performance: 90, accessibility: 95, seo: 95 } },
    visual: { required: true, allowSkip: false, viewports: [375, 768, 1440], thresholds: { horizontalOverflow: 0 } },
  },
};

export class GatesConfigError extends Error {
  constructor(
    message: string,
    readonly problems: string[],
  ) {
    super(`${message}:\n- ${problems.join('\n- ')}`);
    this.name = 'GatesConfigError';
  }
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
const isStringArray = (v: unknown): v is string[] =>
  Array.isArray(v) && v.every((x) => typeof x === 'string');
const isNumberArray = (v: unknown): v is number[] =>
  Array.isArray(v) && v.every((x) => typeof x === 'number' && Number.isFinite(x));

function validateGateEntry(id: string, raw: unknown, problems: string[]): GateConfig | undefined {
  if (raw === null || raw === undefined || raw === true) return {};
  if (raw === false) return { enabled: false };
  if (!isRecord(raw)) {
    problems.push(`gates.${id}: must be a mapping (or true/false)`);
    return undefined;
  }
  const at = (k: string) => `gates.${id}.${k}`;
  for (const key of ['enabled', 'required', 'allowSkip', 'shell'] as const) {
    if (raw[key] !== undefined && typeof raw[key] !== 'boolean') problems.push(`${at(key)}: must be a boolean`);
  }
  if (raw.command !== undefined && (typeof raw.command !== 'string' || raw.command.trim() === '')) {
    problems.push(`${at('command')}: must be a non-empty string`);
  }
  if (raw.timeoutMs !== undefined && (typeof raw.timeoutMs !== 'number' || !(raw.timeoutMs > 0))) {
    problems.push(`${at('timeoutMs')}: must be a positive number`);
  }
  if (raw.thresholds !== undefined) {
    if (!isRecord(raw.thresholds)) problems.push(`${at('thresholds')}: must be a mapping of numbers`);
    else {
      for (const [k, v] of Object.entries(raw.thresholds)) {
        if (typeof v !== 'number' || !Number.isFinite(v)) problems.push(`${at('thresholds')}.${k}: must be a number`);
      }
    }
  }
  for (const key of ['patterns', 'routes', 'include', 'exclude', 'failOn'] as const) {
    if (raw[key] !== undefined && !isStringArray(raw[key])) problems.push(`${at(key)}: must be a list of strings`);
  }
  if (isStringArray(raw.patterns)) {
    for (const p of raw.patterns) {
      try {
        new RegExp(p);
      } catch (err) {
        problems.push(`${at('patterns')}: invalid regex ${JSON.stringify(p)} (${(err as Error).message})`);
      }
    }
  }
  if (isStringArray(raw.failOn)) {
    for (const s of raw.failOn) {
      if (!(AXE_IMPACTS as readonly string[]).includes(s)) {
        problems.push(`${at('failOn')}: unknown severity ${JSON.stringify(s)} (expected ${AXE_IMPACTS.join(', ')})`);
      }
    }
  }
  if (raw.viewports !== undefined && (!isNumberArray(raw.viewports) || raw.viewports.some((w) => w <= 0))) {
    problems.push(`${at('viewports')}: must be a list of positive widths`);
  }
  return raw as GateConfig;
}

function validateServer(raw: unknown, problems: string[]): ServerConfig | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (!isRecord(raw)) {
    problems.push('server: must be a mapping');
    return undefined;
  }
  if (raw.command !== undefined && typeof raw.command !== 'string') problems.push('server.command: must be a string');
  if (raw.url !== undefined) {
    if (typeof raw.url !== 'string') problems.push('server.url: must be a string');
    else {
      try {
        new URL(raw.url);
      } catch {
        problems.push(`server.url: invalid URL ${JSON.stringify(raw.url)}`);
      }
    }
  }
  if (raw.port !== undefined && (typeof raw.port !== 'number' || !Number.isInteger(raw.port) || raw.port <= 0)) {
    problems.push('server.port: must be a positive integer');
  }
  if (raw.readyTimeoutMs !== undefined && (typeof raw.readyTimeoutMs !== 'number' || raw.readyTimeoutMs <= 0)) {
    problems.push('server.readyTimeoutMs: must be a positive number');
  }
  if (raw.shell !== undefined && typeof raw.shell !== 'boolean') problems.push('server.shell: must be a boolean');
  return raw as ServerConfig;
}

/**
 * Top-level `env:` — names of parent-environment variables forwarded to gate processes. Gates run agent-written
 * code, so deploy tokens and LLM keys are rejected outright rather than silently dropped.
 */
function validateEnv(raw: unknown, problems: string[]): string[] | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (!isStringArray(raw)) {
    problems.push('env: must be a list of environment variable names');
    return undefined;
  }
  for (const name of raw) {
    if (!isValidEnvName(name)) problems.push(`env: invalid variable name ${JSON.stringify(name)}`);
    else if (isDeniedGateEnv(name)) {
      problems.push(`env: ${name} is a deploy token / LLM credential and is never passed to gates (gates run agent-written code)`);
    }
  }
  return [...new Set(raw)];
}

/** Validate a parsed gates.yaml document. Gate ids are normalised (`typecheck` → `tsc`). */
export function parseGatesConfig(raw: unknown, source = 'gates.yaml'): FullGatesConfig {
  if (raw === null || raw === undefined) return { gates: {} };
  if (!isRecord(raw)) throw new GatesConfigError(`Invalid ${source}`, ['root: must be a mapping']);
  const problems: string[] = [];
  const gates: Partial<Record<GateId, GateConfig>> = {};
  if (raw.gates !== undefined && raw.gates !== null) {
    if (!isRecord(raw.gates)) problems.push('gates: must be a mapping of gate id → config');
    else {
      for (const [key, value] of Object.entries(raw.gates)) {
        const id = normalizeGateId(key);
        const entry = validateGateEntry(id, value, problems);
        if (entry) gates[id] = { ...(gates[id] ?? {}), ...entry };
      }
    }
  }
  const server = validateServer(raw.server, problems);
  const env = validateEnv(raw.env, problems);
  if (problems.length > 0) throw new GatesConfigError(`Invalid ${source}`, problems);
  const config: FullGatesConfig = { gates };
  if (server) config.server = server;
  if (env) config.env = env;
  return config;
}

export function parseGatesYaml(text: string, source = 'gates.yaml'): FullGatesConfig {
  let doc: unknown;
  try {
    doc = parseYaml(text);
  } catch (err) {
    throw new GatesConfigError(`Invalid ${source}`, [`YAML parse error: ${(err as Error).message}`]);
  }
  return parseGatesConfig(doc, source);
}

/**
 * Read gates.yaml. A missing file yields `fallback` (default: DEFAULT_GATES_CONFIG) so a project
 * without a gates.yaml still gets the documented thresholds.
 */
export async function loadGatesConfig(
  path: string,
  fallback: FullGatesConfig = DEFAULT_GATES_CONFIG,
): Promise<FullGatesConfig> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return structuredClone(fallback);
    throw err;
  }
  return parseGatesYaml(text, path);
}

export function stringifyGatesConfig(config: FullGatesConfig): string {
  return stringifyYaml(config);
}

function findEntry(config: GatesConfig, gate: GateId): GateConfig | undefined {
  const direct = config.gates[gate];
  if (direct) return direct;
  for (const [key, value] of Object.entries(config.gates)) {
    if (normalizeGateId(key) === gate) return value;
  }
  return undefined;
}

function axeThresholds(failOn: readonly string[]): Record<string, number> {
  return Object.fromEntries(failOn.map((impact) => [impact, 0]));
}

/** Merge built-in defaults, then the gate's gates.yaml entry. */
export function resolveGateConfig(config: GatesConfig, gate: GateId): ResolvedGateConfig {
  const id = normalizeGateId(gate);
  const defaults = DEFAULT_GATE_SETTINGS[id] ?? {};
  const user = findEntry(config, id) ?? {};
  const merged: GateConfig = { ...defaults, ...user };
  let thresholds: Record<string, number> = { ...(defaults.thresholds ?? {}), ...(user.thresholds ?? {}) };
  if (id === 'axe') {
    const failOn = (merged.failOn as string[] | undefined) ?? ['critical', 'serious'];
    merged.failOn = failOn;
    thresholds = { ...axeThresholds(failOn), ...(user.thresholds ?? {}) };
  }
  return {
    ...merged,
    enabled: merged.enabled ?? true,
    required: merged.required ?? true,
    // Fail closed: a gate that could not run (missing tool, browser, script) blocks unless gates.yaml opts in.
    allowSkip: typeof merged.allowSkip === 'boolean' ? merged.allowSkip : false,
    timeoutMs: merged.timeoutMs ?? FALLBACK_TIMEOUT_MS,
    thresholds,
  };
}

/** Gate ids configured in gates.yaml and enabled, in config order. */
export function enabledGates(config: GatesConfig): GateId[] {
  return Object.keys(config.gates)
    .map((k) => normalizeGateId(k))
    .filter((id, i, all) => all.indexOf(id) === i)
    .filter((id) => resolveGateConfig(config, id).enabled);
}

/** True when the gate has a built-in runner or a `command` to run. */
export function isRunnableGate(config: GatesConfig, gate: GateId): boolean {
  return isBuiltinGate(gate) || typeof findEntry(config, gate)?.command === 'string';
}
