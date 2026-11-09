/** Helpers shared by gate implementations for building GateOutcomes. */
import type { GateIssue } from '../contracts.js';
import { formatCommand, outputTail } from '../exec/command.js';
import { describeViolation, evaluateThresholds } from '../thresholds.js';
import type { CommandSpec, ExecResult, GateOutcome, GateRunContext } from '../types.js';

export const SKIPPED_PREFIX = 'SKIPPED';

export function skipped(reason: string, extra: Partial<GateOutcome> = {}): GateOutcome {
  return { status: 'skipped', summary: `${SKIPPED_PREFIX}: ${reason}`, issues: [], ...extra };
}

export function errored(message: string, extra: Partial<GateOutcome> = {}): GateOutcome {
  return {
    status: 'error',
    summary: message,
    issues: [{ severity: 'error', message }],
    ...extra,
  };
}

/** Run a command inside the gate's cwd with the gate's timeout and the context's abort signal. */
export async function runGateCommand(rc: GateRunContext, cmd: CommandSpec, env?: Record<string, string>): Promise<ExecResult> {
  const opts: Parameters<GateRunContext['exec']['exec']>[1] = { cwd: rc.ctx.cwd, timeoutMs: rc.config.timeoutMs };
  if (rc.ctx.signal) opts.signal = rc.ctx.signal;
  if (env) opts.env = env;
  if (rc.fullConfig.env?.length) opts.passEnv = rc.fullConfig.env;
  return rc.exec.exec(cmd, opts);
}

/**
 * Map a process that did not finish normally (could not start, timed out, aborted) to an
 * outcome. Returns undefined when the process ran to completion.
 */
export function abnormalExit(cmd: CommandSpec, res: ExecResult): GateOutcome | undefined {
  const shown = formatCommand(cmd);
  if (res.spawnError) return errored(`could not start \`${shown}\`: ${res.spawnError}`);
  if (res.aborted) return errored(`aborted while running \`${shown}\``, { output: outputTail(res) });
  if (res.timedOut) {
    return {
      status: 'failed',
      summary: `\`${shown}\` timed out after ${Math.round(res.durationMs / 1000)}s`,
      issues: [{ severity: 'error', message: 'timed out' }],
      output: outputTail(res),
    };
  }
  return undefined;
}

/**
 * Turn measured metrics + issues into a pass/fail outcome against the gate's thresholds.
 * `okSummary` is used when every threshold holds.
 */
export function thresholdOutcome(
  rc: GateRunContext,
  metrics: Record<string, number>,
  issues: GateIssue[],
  okSummary: string,
  extra: Partial<GateOutcome> = {},
  opts: { ignoreMissing?: boolean } = {},
): GateOutcome {
  const thresholds = rc.config.thresholds;
  const evaluation = evaluateThresholds(metrics, thresholds, opts);
  if (evaluation.passed) {
    return { status: 'passed', summary: okSummary, issues, metrics, thresholds, ...extra };
  }
  return {
    status: 'failed',
    summary: `threshold not met: ${evaluation.violations.map(describeViolation).join(', ')}`,
    issues,
    metrics,
    thresholds,
    ...extra,
  };
}

export function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}
