#!/usr/bin/env node
/** agent-gates CLI entry. Exit codes: 0 gates passed, 1 gates failed, 2 usage/config error. */
import { appendFile, mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { GatesConfigError } from '../config.js';
import { githubAnnotations } from './annotations.js';
import { assertKnownFlags, flagBool, flagString, parseArgs, UsageError } from './args.js';
import type { ParsedArgs } from './args.js';
import { detectGates } from './detect.js';
import { formatGateLine, formatVerdict, paint } from './format.js';
import type { Style } from './format.js';
import { DEFAULT_MAX_BLOCKS, parseHookInput, runStopHook } from './hook.js';
import { runInit } from './init.js';
import { CliError, STATE_DIR, findProjectRoot, runGates } from './run.js';
import { VERSION } from './version.js';

const HELP = `agent-gates ${VERSION} — hard quality gates for any coding agent

Usage
  agent-gates [gate...]        run the gates (all configured, or detected if no config)
  agent-gates init             write agent-gates.yaml for this project
  agent-gates detect           show which gates apply here and why
  agent-gates hook claude      Claude Code Stop hook (installed by init --claude)
  agent-gates hook codex       Codex CLI Stop hook (installed by init --codex)
                               --max-blocks <n> (default 3)  --output context|block
                               --no-fail-fast (by default the hook stops at the first failing gate)

Run options
  --json                       print the report as JSON
  -c, --config <file>          config file (default: agent-gates.yaml, else auto-detect)
  --spec <file>                spec YAML with pages/sections: enables the playwright smoke gate
  --out <dir>                  report + screenshots dir (default: .agent-gates/last)
  --cwd <dir>                  project directory (default: current directory)
  --fail-fast                  stop at the first failing gate
  --no-annotations             in GitHub Actions, do not print ::error annotations
  --no-color

Init options
  --claude                     add a Stop hook to .claude/settings.json
  --codex                      add a Stop hook to .codex/hooks.json
  --agents-md                  add a "definition of done" block to AGENTS.md
  --github                     add .github/workflows/agent-gates.yml
  --all                        all of the above
  --no-baseline                fail on existing content findings too
  --force                      overwrite existing files

Gates: tsc, eslint, build, tests, content-lint, playwright, axe, visual, lighthouse
Exit codes: 0 passed, 1 failed, 2 usage or config error
Docs: https://github.com/artelo-dev/agent-gates`;

function style(args: ParsedArgs): Style {
  return { color: process.stdout.isTTY === true && !process.env.NO_COLOR && !flagBool(args, 'no-color') };
}

function cwdOf(args: ParsedArgs): string {
  return resolve(flagString(args, 'cwd') ?? process.cwd());
}

async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) return '';
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

async function cmdRun(args: ParsedArgs, gates: string[]): Promise<number> {
  assertKnownFlags(args, ['json', 'config', 'spec', 'out', 'cwd', 'no-color', 'no-annotations', 'fail-fast']);
  const s = style(args);
  const json = flagBool(args, 'json');
  const controller = new AbortController();
  process.once('SIGINT', () => controller.abort());
  const cwd = cwdOf(args);
  const opts: Parameters<typeof runGates>[0] = { cwd, gates, signal: controller.signal, failFast: flagBool(args, 'fail-fast') };
  const config = flagString(args, 'config');
  const spec = flagString(args, 'spec');
  const out = flagString(args, 'out');
  if (config) opts.configPath = config;
  if (spec) opts.specPath = spec;
  if (out) opts.outDir = out;
  if (!json) {
    let printedHeader = false;
    opts.onGateStart = () => {
      if (printedHeader) return;
      printedHeader = true;
    };
    opts.onGateResult = (r) => console.log(formatGateLine(r, s));
  }
  const { report, loaded, reportPath } = await runGates(opts);
  if (process.env.GITHUB_ACTIONS === 'true' && !flagBool(args, 'no-annotations')) {
    for (const line of githubAnnotations(report)) console.log(line);
  }
  if (json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log('');
    console.log(formatVerdict(report, s, reportPath));
    if (!loaded.source) {
      console.log(paint(s, 'gray', 'No agent-gates.yaml: ran the detected static gates. `npx agent-gates init` adds browser gates and agent hooks.'));
    }
  }
  return report.passed ? 0 : 1;
}

async function cmdInit(args: ParsedArgs): Promise<number> {
  assertKnownFlags(args, ['claude', 'codex', 'agents-md', 'github', 'all', 'no-baseline', 'force', 'cwd', 'no-color']);
  const s = style(args);
  const all = flagBool(args, 'all');
  const result = await runInit({
    cwd: cwdOf(args),
    force: flagBool(args, 'force'),
    claude: all || flagBool(args, 'claude'),
    codex: all || flagBool(args, 'codex'),
    agentsMd: all || flagBool(args, 'agents-md'),
    github: all || flagBool(args, 'github'),
    baseline: !flagBool(args, 'no-baseline'),
  });
  for (const step of result.steps) {
    const mark = step.action === 'skipped' ? paint(s, 'yellow', step.action) : step.action === 'unchanged' ? paint(s, 'gray', step.action) : paint(s, 'green', step.action);
    console.log(`${mark.padEnd(s.color ? 18 : 9)} ${step.file}${step.note ? paint(s, 'gray', `  ${step.note}`) : ''}`);
  }
  const on = result.detection.decisions.filter((d) => d.enabled).map((d) => d.gate);
  console.log(`\nGates on: ${on.join(', ') || 'none'}`);
  if (!flagBool(args, 'claude') && !all) console.log(paint(s, 'gray', 'Claude Code: `npx agent-gates init --claude` blocks "done" while gates fail.'));
  if (!flagBool(args, 'agents-md') && !all) console.log(paint(s, 'gray', 'Codex / Gemini CLI / Cursor: `npx agent-gates init --agents-md`.'));
  console.log('Next: `npx agent-gates`');
  return 0;
}

async function cmdDetect(args: ParsedArgs): Promise<number> {
  assertKnownFlags(args, ['cwd', 'json', 'no-color']);
  const s = style(args);
  const detection = await detectGates(cwdOf(args));
  if (flagBool(args, 'json')) {
    console.log(JSON.stringify(detection, null, 2));
    return 0;
  }
  for (const d of detection.decisions) {
    console.log(`${d.enabled ? paint(s, 'green', 'on ') : paint(s, 'gray', 'off')} ${d.gate.padEnd(13)} ${paint(s, 'gray', d.reason)}`);
  }
  return 0;
}

async function cmdHook(args: ParsedArgs, target: string | undefined): Promise<number> {
  assertKnownFlags(args, ['max-blocks', 'config', 'spec', 'cwd', 'output', 'no-fail-fast']);
  if (target !== 'claude' && target !== 'codex') throw new UsageError('usage: agent-gates hook claude|codex');
  // Codex has no additionalContext for Stop: decision:block is its continuation mechanism.
  const output = flagString(args, 'output') ?? (target === 'codex' ? 'block' : 'context');
  if (output !== 'context' && output !== 'block') throw new UsageError('--output must be "context" or "block"');
  if (target === 'codex' && output !== 'block') throw new UsageError('Codex supports only --output block');
  const raw = await readStdin();
  const input = parseHookInput(raw);
  const explicit = flagString(args, 'cwd') ?? (target === 'claude' ? process.env.CLAUDE_PROJECT_DIR : undefined);
  const cwd = explicit ? resolve(explicit) : await findProjectRoot(input.cwd ?? process.cwd());
  if (process.env.AGENT_GATES_DEBUG) {
    await mkdir(join(cwd, STATE_DIR), { recursive: true });
    await appendFile(join(cwd, STATE_DIR, 'hook-input.log'), `${new Date().toISOString()} ${raw.trim()}\n`);
  }
  const maxRaw = flagString(args, 'max-blocks');
  const maxBlocks = maxRaw === undefined ? DEFAULT_MAX_BLOCKS : Number(maxRaw);
  if (!Number.isInteger(maxBlocks) || maxBlocks < 1) throw new UsageError('--max-blocks must be a positive integer');
  const opts: Parameters<typeof runStopHook>[0] = { cwd, input, maxBlocks, failFast: !flagBool(args, 'no-fail-fast') };
  const config = flagString(args, 'config');
  const spec = flagString(args, 'spec');
  if (config) opts.configPath = config;
  if (spec) opts.specPath = spec;
  const response = await runStopHook(opts);
  // JSON on stdout, never exit 2 + stderr: Claude Code treats an exit-2 stderr that contains
  // "No such file or directory" as a non-blocking error, and gate output can contain that.
  // Default `context` continues the turn with the failures as "Stop hook feedback" (no hook-error
  // notice in the UI); `block` uses decision:block. Both set stop_hook_active on the next stop.
  if (response.kind === 'block') {
    const out =
      output === 'block'
        ? { decision: 'block', reason: response.reason }
        : { hookSpecificOutput: { hookEventName: 'Stop', additionalContext: response.reason } };
    process.stdout.write(`${JSON.stringify(out)}\n`);
    return 0;
  }
  if (response.kind === 'warn') process.stdout.write(`${JSON.stringify({ systemMessage: response.message })}\n`);
  return 0;
}

export async function main(argv: readonly string[]): Promise<number> {
  const args = parseArgs(argv);
  if (flagBool(args, 'version')) {
    console.log(VERSION);
    return 0;
  }
  const [first, ...rest] = args.positionals;
  if (flagBool(args, 'help') || first === 'help') {
    console.log(HELP);
    return 0;
  }
  switch (first) {
    case 'init':
      return cmdInit(args);
    case 'detect':
      return cmdDetect(args);
    case 'hook':
      return cmdHook(args, rest[0]);
    case 'run':
      return cmdRun(args, rest);
    default:
      return cmdRun(args, args.positionals);
  }
}

function report(err: unknown): number {
  if (err instanceof GatesConfigError) {
    console.error(`agent-gates: ${err.message}`);
    for (const p of err.problems) console.error(`  - ${p}`);
    return 2;
  }
  if (err instanceof UsageError || err instanceof CliError) {
    console.error(`agent-gates: ${err.message}`);
    if (err instanceof UsageError) console.error('Run `agent-gates --help` for usage.');
    return 2;
  }
  console.error(`agent-gates: ${(err as Error).stack ?? String(err)}`);
  return 2;
}

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (err: unknown) => {
    process.exitCode = report(err);
  },
);
