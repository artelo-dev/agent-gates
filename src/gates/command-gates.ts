/**
 * Gates that run a project command: tsc, eslint, build, tests, and any custom gate with a
 * `command` in gates.yaml.
 */
import { readFile } from 'node:fs/promises';
import { isAbsolute, join, relative } from 'node:path';
import type { GateIssue } from '../contracts.js';
import { commandFromString, formatCommand, outputTail } from '../exec/command.js';
import {
  ESLINT_CONFIG_FILES,
  TSCONFIG_FILES,
  findUp,
  firstExisting,
  isPlaceholderTestScript,
  pathExists,
  runScriptCommand,
  toolCommand,
} from '../project.js';
import type { CommandSpec, GateImplementation, GateOutcome, GateRunContext } from '../types.js';
import { abnormalExit, plural, runGateCommand, skipped, thresholdOutcome } from './outcome.js';

/** The gates.yaml `command` override, when present. */
function configuredCommand(rc: GateRunContext): CommandSpec | undefined {
  const line = rc.config.command;
  return typeof line === 'string' ? commandFromString(line, rc.config.shell === true) : undefined;
}

// ---------------------------------------------------------------------------
// tsc
// ---------------------------------------------------------------------------

const TSC_LINE = /^(.+?)\((\d+),(\d+)\):\s+(error|warning)\s+(TS\d+):\s+(.*)$/;
const TSC_PRETTY_LINE = /^(.+?):(\d+):(\d+)\s+-\s+(error|warning)\s+(TS\d+):\s+(.*)$/;
const TSC_GLOBAL_LINE = /^(error|warning)\s+(TS\d+):\s+(.*)$/;

/** Parse `tsc --pretty false` (and pretty) diagnostics. */
export function parseTscOutput(output: string): GateIssue[] {
  const issues: GateIssue[] = [];
  for (const raw of output.split(/\r?\n/)) {
    const line = raw.trim();
    const m = TSC_LINE.exec(line) ?? TSC_PRETTY_LINE.exec(line);
    if (m) {
      issues.push({
        severity: m[4] === 'warning' ? 'warning' : 'error',
        file: m[1] as string,
        line: Number(m[2]),
        column: Number(m[3]),
        rule: m[5] as string,
        message: m[6] as string,
      });
      continue;
    }
    const g = TSC_GLOBAL_LINE.exec(line);
    if (g) issues.push({ severity: g[1] === 'warning' ? 'warning' : 'error', rule: g[2] as string, message: g[3] as string });
  }
  return issues;
}

/**
 * Next.js 15.5+ declares route types (`LayoutProps`, `PageProps`, ...) in generated `.next/types`.
 * On a fresh clone (CI, a new worktree) those files do not exist yet and tsc fails on a correct
 * project. When the tsconfig includes them and they are missing, generate them first with
 * `next typegen` (no build). A failure here is ignored: tsc then reports the real problem.
 */
async function nextTypegen(rc: GateRunContext, tsconfig: string): Promise<void> {
  let text: string;
  try {
    text = await readFile(join(rc.ctx.cwd, tsconfig), 'utf8');
  } catch {
    return;
  }
  const dirs = [...new Set([...text.matchAll(/["'](\.next[\w-]*)\/types\//g)].map((m) => m[1] as string))];
  if (dirs.length === 0) return;
  for (const dir of dirs) if (await pathExists(join(rc.ctx.cwd, dir, 'types'))) return;
  const next = await rc.probe.findBin('next', rc.ctx.cwd);
  if (!next) return;
  await runGateCommand(rc, { command: next, args: ['typegen'] });
}

export const tscGate: GateImplementation = {
  id: 'tsc',
  async run(rc) {
    let cmd = configuredCommand(rc);
    if (!cmd) {
      const tsconfig = await firstExisting(rc.ctx.cwd, TSCONFIG_FILES);
      if (!tsconfig) return skipped('no tsconfig.json in project');
      await nextTypegen(rc, tsconfig);
      cmd = await toolCommand(rc.probe, rc.ctx.cwd, 'tsc', ['--noEmit', '--pretty', 'false', '-p', tsconfig]);
    }
    const res = await runGateCommand(rc, cmd);
    const abnormal = abnormalExit(cmd, res);
    if (abnormal) return abnormal;
    const issues = parseTscOutput(`${res.stdout}\n${res.stderr}`);
    const errors = issues.filter((i) => i.severity === 'error').length;
    if (res.exitCode !== 0 && errors === 0) {
      return {
        status: 'failed',
        summary: `\`${formatCommand(cmd)}\` exited with code ${res.exitCode}`,
        issues: [{ severity: 'error', message: `exit code ${res.exitCode}` }],
        metrics: { errors: 1 },
        output: outputTail(res),
      };
    }
    return thresholdOutcome(rc, { errors }, issues, 'no type errors', {
      ...(errors > 0 ? { output: outputTail(res) } : {}),
      ...(errors > 0 ? { summary: plural(errors, 'type error') } : {}),
    });
  },
};

// ---------------------------------------------------------------------------
// eslint
// ---------------------------------------------------------------------------

interface EslintMessage {
  ruleId?: string | null;
  severity?: number;
  message?: string;
  line?: number;
  column?: number;
  fatal?: boolean;
}

interface EslintFileResult {
  filePath?: string;
  messages?: EslintMessage[];
}

/** Parse `eslint --format json` output (tolerates package-manager noise around the JSON). */
export function parseEslintJson(stdout: string, cwd: string): { issues: GateIssue[]; errors: number; warnings: number } | undefined {
  const start = stdout.indexOf('[');
  const end = stdout.lastIndexOf(']');
  if (start === -1 || end <= start) return undefined;
  let data: unknown;
  try {
    data = JSON.parse(stdout.slice(start, end + 1));
  } catch {
    return undefined;
  }
  if (!Array.isArray(data)) return undefined;
  const issues: GateIssue[] = [];
  let errors = 0;
  let warnings = 0;
  for (const file of data as EslintFileResult[]) {
    const filePath = file.filePath && isAbsolute(file.filePath) ? relative(cwd, file.filePath) : file.filePath;
    for (const m of file.messages ?? []) {
      const isError = m.fatal === true || m.severity === 2;
      if (isError) errors++;
      else warnings++;
      const issue: GateIssue = { severity: isError ? 'error' : 'warning', message: m.message ?? 'unknown problem' };
      if (filePath) issue.file = filePath;
      if (m.line !== undefined) issue.line = m.line;
      if (m.column !== undefined) issue.column = m.column;
      if (m.ruleId) issue.rule = m.ruleId;
      issues.push(issue);
    }
  }
  return { issues, errors, warnings };
}

export const eslintGate: GateImplementation = {
  id: 'eslint',
  async run(rc) {
    let cmd = configuredCommand(rc);
    if (!cmd) {
      // ESLint resolves its config upwards, so a monorepo package may rely on the root config.
      const configFile = await findUp(rc.ctx.cwd, ESLINT_CONFIG_FILES);
      if (!configFile) return skipped('no eslint config in project or its ancestors (up to the git root)');
      cmd = await toolCommand(rc.probe, rc.ctx.cwd, 'eslint', ['.', '--format', 'json']);
    }
    const res = await runGateCommand(rc, cmd);
    const abnormal = abnormalExit(cmd, res);
    if (abnormal) return abnormal;
    const parsed = parseEslintJson(res.stdout, rc.ctx.cwd);
    if (!parsed) {
      // Custom command without JSON output: fall back to the exit code.
      return res.exitCode === 0
        ? { status: 'passed', summary: 'eslint passed', issues: [], metrics: { errors: 0 }, thresholds: rc.config.thresholds }
        : {
            status: 'failed',
            summary: `\`${formatCommand(cmd)}\` exited with code ${res.exitCode}`,
            issues: [{ severity: 'error', message: `exit code ${res.exitCode}` }],
            metrics: { errors: 1 },
            thresholds: rc.config.thresholds,
            output: outputTail(res),
          };
    }
    const { issues, errors, warnings } = parsed;
    if (res.exitCode !== 0 && errors === 0 && res.exitCode !== 1) {
      // exit 2 = eslint itself crashed / config error
      return {
        status: 'failed',
        summary: `eslint failed with exit code ${res.exitCode}`,
        issues: [{ severity: 'error', message: `exit code ${res.exitCode}` }],
        output: outputTail(res),
      };
    }
    const outcome = thresholdOutcome(rc, { errors, warnings }, issues, warnings > 0 ? `0 errors, ${plural(warnings, 'warning')}` : 'no lint problems');
    if (outcome.status === 'failed' && errors > 0) outcome.summary = `${plural(errors, 'lint error')}, ${plural(warnings, 'warning')}`;
    return outcome;
  },
};

// ---------------------------------------------------------------------------
// build / tests / custom
// ---------------------------------------------------------------------------

async function exitCodeGate(rc: GateRunContext, cmd: CommandSpec, label: string): Promise<GateOutcome> {
  const res = await runGateCommand(rc, cmd);
  const abnormal = abnormalExit(cmd, res);
  if (abnormal) return abnormal;
  if (res.exitCode === 0) {
    return { status: 'passed', summary: `${label} succeeded`, issues: [], output: outputTail(res, 1500) };
  }
  return {
    status: 'failed',
    summary: `${label} failed: \`${formatCommand(cmd)}\` exited with code ${res.exitCode}`,
    issues: [{ severity: 'error', message: `exit code ${res.exitCode}` }],
    output: outputTail(res),
  };
}

export const buildGate: GateImplementation = {
  id: 'build',
  async run(rc) {
    const cmd = configuredCommand(rc) ?? (rc.project.scripts.build ? runScriptCommand(rc.project, 'build') : undefined);
    if (!cmd) return skipped('no build command configured and no "build" script in package.json');
    return exitCodeGate(rc, cmd, 'build');
  },
};

export const testsGate: GateImplementation = {
  id: 'tests',
  async run(rc) {
    const script = rc.project.scripts.test;
    const cmd = configuredCommand(rc) ?? (isPlaceholderTestScript(script) ? undefined : runScriptCommand(rc.project, 'test'));
    if (!cmd) return skipped('no test command configured and no "test" script in package.json');
    return exitCodeGate(rc, cmd, 'tests');
  },
};

/** Runner for a gate id without a built-in implementation but with a `command`. */
export function customCommandGate(id: string): GateImplementation {
  return {
    id,
    async run(rc) {
      const cmd = configuredCommand(rc);
      if (!cmd) return skipped(`gate "${id}" has no built-in runner and no command in gates.yaml`);
      return exitCodeGate(rc, cmd, id);
    },
  };
}
