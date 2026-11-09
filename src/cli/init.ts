/**
 * `agent-gates init`: write agent-gates.yaml from what is detected, record a content-lint
 * baseline for existing findings, ignore the state dir, and optionally wire the gates into
 * Claude Code (Stop hook), AGENTS.md (Codex, Gemini CLI, Cursor, ...) and GitHub Actions.
 * Every step is idempotent; existing files are never overwritten without --force.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { GateConfig } from '../contracts.js';
import { DEFAULT_GATE_SETTINGS } from '../config.js';
import { FsToolProbe } from '../exec/probe.js';
import { buildBaseline, writeBaseline } from '../gates/content-lint/baseline.js';
import { lintContent } from '../gates/content-lint/lint.js';
import { firstExisting, pathExists } from '../project.js';
import type { ToolProbe } from '../types.js';
import { CONFIG_FILES, detectGates } from './detect.js';
import type { Detection } from './detect.js';
import { STATE_DIR } from './run.js';
import { VERSION } from './version.js';

export const CONFIG_FILE = CONFIG_FILES[0];
export const BASELINE_FILE = 'agent-gates.baseline.json';
export const AGENTS_START = '<!-- agent-gates:start -->';
export const AGENTS_END = '<!-- agent-gates:end -->';
export const HOOK_TIMEOUT_SECONDS = 900;

export interface InitOptions {
  cwd: string;
  force?: boolean;
  claude?: boolean;
  agentsMd?: boolean;
  github?: boolean;
  /** Record existing content findings in a baseline (default true). */
  baseline?: boolean;
  probe?: ToolProbe;
}

export interface InitStep {
  file: string;
  action: 'created' | 'updated' | 'unchanged' | 'skipped';
  note?: string;
}

export interface InitResult {
  detection: Detection;
  steps: InitStep[];
  hookCommand: string;
}

// ---------------------------------------------------------------------------
// agent-gates.yaml
// ---------------------------------------------------------------------------

function yamlValue(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(yamlValue).join(', ')}]`;
  if (v && typeof v === 'object') return `{ ${Object.entries(v).map(([k, x]) => `${k}: ${yamlValue(x)}`).join(', ')} }`;
  if (typeof v === 'string') return /^[\w./-]+$/.test(v) ? v : JSON.stringify(v);
  return String(v);
}

/** The thresholds worth showing in the generated file (the rest stay built-in defaults). */
function visibleSettings(gate: string): GateConfig {
  const d = DEFAULT_GATE_SETTINGS[gate] ?? {};
  const out: GateConfig = {};
  if (d.thresholds && gate !== 'content-lint' && gate !== 'tsc' && gate !== 'eslint') out.thresholds = d.thresholds;
  if (d.failOn) out.failOn = d.failOn;
  if (d.viewports) out.viewports = d.viewports;
  return out;
}

export function renderConfig(detection: Detection, opts: { baseline?: string } = {}): string {
  const lines = [
    `# yaml-language-server: $schema=https://unpkg.com/agent-gates@${VERSION}/schema/agent-gates.schema.json`,
    '# agent-gates: "done" means these checks passed, not that the agent said so.',
    '# Docs: https://github.com/artelo-dev/agent-gates#configuration',
    '#',
    '# allowSkip: false  a gate that cannot run (missing tool, browser, script) FAILS instead of passing quietly',
    '# required: false   the gate is reported but never blocks',
    '',
  ];
  if (detection.web) {
    lines.push(
      '# Browser gates build the app, then serve it with the "start" script on this port.',
      'server:',
      '  port: 3100',
      '',
    );
  }
  lines.push('gates:');
  for (const d of detection.decisions) {
    lines.push(`  ${d.gate}:  # ${d.reason}`);
    if (!d.enabled) lines.push('    enabled: false');
    lines.push('    allowSkip: false');
    for (const [k, v] of Object.entries(visibleSettings(d.gate))) lines.push(`    ${k}: ${yamlValue(v)}`);
    if (d.gate === 'content-lint' && opts.baseline) {
      lines.push(`    baseline: ${opts.baseline}  # findings that existed at init; only new ones fail`);
    }
  }
  lines.push(
    '',
    '# Variables forwarded to gate commands. Gates run agent-written code, so they get a scrubbed',
    '# environment; deploy tokens and LLM keys are refused even if listed.',
    '# env: [NEXT_PUBLIC_SITE_URL]',
    '',
  );
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Claude Code Stop hook
// ---------------------------------------------------------------------------

/** How agents and hooks invoke agent-gates: the project's install if there is one, else a pinned npx. */
export async function runCommand(cwd: string, probe: ToolProbe): Promise<string> {
  const local = await probe.findBin('agent-gates', cwd);
  return local ? 'npx --no-install agent-gates' : `npx --yes agent-gates@${VERSION}`;
}

export async function hookCommand(cwd: string, probe: ToolProbe): Promise<string> {
  return `${await runCommand(cwd, probe)} hook claude`;
}

interface HookEntry {
  type?: string;
  command?: string;
  timeout?: number;
}
interface HookGroup {
  matcher?: string;
  hooks?: HookEntry[];
}

/** Add our Stop hook to a parsed settings.json; returns false when it is already there. */
export function addStopHook(settings: Record<string, unknown>, command: string): boolean {
  const hooks = (settings.hooks && typeof settings.hooks === 'object' ? settings.hooks : (settings.hooks = {})) as Record<string, unknown>;
  const stop = (Array.isArray(hooks.Stop) ? hooks.Stop : (hooks.Stop = [])) as HookGroup[];
  for (const group of stop) {
    for (const h of group.hooks ?? []) {
      if (typeof h.command === 'string' && /\bagent-gates\b.*\bhook claude\b/.test(h.command)) {
        if (h.command === command && h.timeout === HOOK_TIMEOUT_SECONDS) return false;
        h.command = command;
        h.timeout = HOOK_TIMEOUT_SECONDS;
        return true;
      }
    }
  }
  stop.push({ hooks: [{ type: 'command', command, timeout: HOOK_TIMEOUT_SECONDS }] });
  return true;
}

async function writeClaudeHook(cwd: string, command: string): Promise<InitStep> {
  const file = join('.claude', 'settings.json');
  const abs = join(cwd, file);
  let settings: Record<string, unknown> = {};
  let existed = false;
  try {
    const text = await readFile(abs, 'utf8');
    existed = true;
    const parsed: unknown = JSON.parse(text);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { file, action: 'skipped', note: 'not a JSON object; add the hook by hand (see README)' };
    }
    settings = parsed as Record<string, unknown>;
  } catch (err) {
    if (existed) return { file, action: 'skipped', note: `invalid JSON (${(err as Error).message}); add the hook by hand` };
  }
  if (!addStopHook(settings, command)) return { file, action: 'unchanged', note: 'Stop hook already installed' };
  await mkdir(dirname(abs), { recursive: true });
  await writeFile(abs, `${JSON.stringify(settings, null, 2)}\n`);
  return { file, action: existed ? 'updated' : 'created', note: 'Stop hook: Claude cannot finish while gates fail' };
}

// ---------------------------------------------------------------------------
// AGENTS.md
// ---------------------------------------------------------------------------

export function agentsBlock(command = 'npx agent-gates'): string {
  return [
    AGENTS_START,
    '## Definition of done',
    '',
    `A task is not done until \`${command}\` exits with code 0. Run it before you say you are finished.`,
    'If it fails, fix what it reports and run it again. Do not weaken or skip a gate, do not edit',
    '`agent-gates.yaml` or `agent-gates.baseline.json`, and do not mark a check as passed yourself.',
    AGENTS_END,
  ].join('\n');
}

export function upsertAgentsBlock(text: string, command?: string): string {
  const block = agentsBlock(command);
  const start = text.indexOf(AGENTS_START);
  const end = text.indexOf(AGENTS_END);
  if (start !== -1 && end > start) return `${text.slice(0, start)}${block}${text.slice(end + AGENTS_END.length)}`;
  if (text.trim() === '') return `${block}\n`;
  return `${text.replace(/\s*$/, '')}\n\n${block}\n`;
}

async function writeAgentsMd(cwd: string, command: string): Promise<InitStep> {
  const file = 'AGENTS.md';
  const abs = join(cwd, file);
  let text = '';
  let existed = true;
  try {
    text = await readFile(abs, 'utf8');
  } catch {
    existed = false;
  }
  const next = upsertAgentsBlock(text, command);
  if (next === text) return { file, action: 'unchanged' };
  await writeFile(abs, next);
  return { file, action: existed ? 'updated' : 'created', note: 'definition of done for Codex, Gemini CLI, Cursor and other agents' };
}

// ---------------------------------------------------------------------------
// GitHub Actions
// ---------------------------------------------------------------------------

export function githubWorkflow(detection: Detection): string {
  const pm = detection.project.packageManager;
  const install = { pnpm: 'pnpm install --frozen-lockfile', yarn: 'yarn install --frozen-lockfile', bun: 'bun install --frozen-lockfile', npm: 'npm ci' }[pm];
  const lines = [
    'name: agent-gates',
    'on: [push, pull_request]',
    'jobs:',
    '  gates:',
    '    runs-on: ubuntu-latest',
    '    steps:',
    '      - uses: actions/checkout@v4',
  ];
  if (pm === 'pnpm') lines.push('      - uses: pnpm/action-setup@v4');
  if (pm === 'bun') lines.push('      - uses: oven-sh/setup-bun@v2');
  lines.push('      - uses: actions/setup-node@v4', '        with:', '          node-version: 22');
  lines.push(`      - run: ${install}`);
  if (detection.web?.hasPlaywright) lines.push('      - run: npx playwright install --with-deps chromium');
  lines.push(`      - run: npx --yes agent-gates@${VERSION}`);
  lines.push('      - if: always()', '        uses: actions/upload-artifact@v4', '        with:', '          name: agent-gates-report', `          path: ${STATE_DIR}/last`, '');
  return lines.join('\n');
}

async function writeGithubWorkflow(cwd: string, detection: Detection, force: boolean): Promise<InitStep> {
  const file = join('.github', 'workflows', 'agent-gates.yml');
  const abs = join(cwd, file);
  const existed = await pathExists(abs);
  if (existed && !force) return { file, action: 'skipped', note: 'exists (use --force to overwrite)' };
  await mkdir(dirname(abs), { recursive: true });
  await writeFile(abs, githubWorkflow(detection));
  return { file, action: existed ? 'updated' : 'created' };
}

// ---------------------------------------------------------------------------

async function ensureGitignore(cwd: string): Promise<InitStep> {
  const file = '.gitignore';
  const abs = join(cwd, file);
  let text = '';
  let existed = true;
  try {
    text = await readFile(abs, 'utf8');
  } catch {
    existed = false;
  }
  const has = text.split(/\r?\n/).some((l) => /^\/?\.agent-gates\/?$/.test(l.trim()));
  if (has) return { file, action: 'unchanged' };
  await writeFile(abs, `${text}${text && !text.endsWith('\n') ? '\n' : ''}${STATE_DIR}/\n`);
  return { file, action: existed ? 'updated' : 'created', note: `ignore ${STATE_DIR}/ (reports, hook state)` };
}

export async function runInit(opts: InitOptions): Promise<InitResult> {
  const probe = opts.probe ?? new FsToolProbe();
  const detection = await detectGates(opts.cwd, probe);
  const steps: InitStep[] = [];

  const existingConfig = await firstExisting(opts.cwd, CONFIG_FILES);
  if (existingConfig && !opts.force) {
    steps.push({ file: existingConfig, action: 'skipped', note: 'exists (use --force to regenerate)' });
  } else {
    let baseline: string | undefined;
    if (opts.baseline !== false) {
      const { findings } = await lintContent(opts.cwd);
      if (findings.length > 0) {
        await writeBaseline(join(opts.cwd, BASELINE_FILE), buildBaseline(findings));
        baseline = BASELINE_FILE;
        steps.push({ file: BASELINE_FILE, action: 'created', note: `${findings.length} existing content findings; only new ones will fail` });
      }
    }
    const target = existingConfig ?? CONFIG_FILE;
    await writeFile(join(opts.cwd, target), renderConfig(detection, baseline ? { baseline } : {}));
    steps.push({ file: target, action: existingConfig ? 'updated' : 'created' });
  }

  steps.push(await ensureGitignore(opts.cwd));
  const command = await hookCommand(opts.cwd, probe);
  if (opts.claude) steps.push(await writeClaudeHook(opts.cwd, command));
  if (opts.agentsMd) steps.push(await writeAgentsMd(opts.cwd, await runCommand(opts.cwd, probe)));
  if (opts.github) steps.push(await writeGithubWorkflow(opts.cwd, detection, opts.force === true));
  return { detection, steps, hookCommand: command };
}
