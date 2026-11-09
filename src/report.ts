/** GateReport aggregation, persistence and human-readable formatting. */
import { mkdir, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { GateId, GateReport, GateResult, GateStatus } from './contracts.js';

export const GATE_REPORT_FILE = 'gates.json';

/** How each gate's result counts towards `GateReport.passed`. */
export interface GatePolicy {
  required: boolean;
  /** When false, `skipped` counts as a failure. */
  allowSkip: boolean;
}

export type GateStatusCounts = Record<GateStatus, number> & { total: number };

/** A result blocks the report when it is required and not passed (or skipped where allowed). */
export function isBlocking(result: GateResult, policy: GatePolicy = { required: true, allowSkip: false }): boolean {
  if (!policy.required) return false;
  if (result.status === 'passed') return false;
  if (result.status === 'skipped') return !policy.allowSkip;
  return true;
}

export function aggregateReport(input: {
  runId: string;
  taskId?: string;
  startedAt: string;
  finishedAt: string;
  results: GateResult[];
  policies?: Partial<Record<GateId, GatePolicy>>;
}): GateReport {
  const results = input.results.map((r) => ({ ...r, blocking: isBlocking(r, input.policies?.[r.gate]) }));
  const report: GateReport = {
    runId: input.runId,
    passed: results.every((r) => !r.blocking),
    startedAt: input.startedAt,
    finishedAt: input.finishedAt,
    results,
  };
  if (input.taskId !== undefined) report.taskId = input.taskId;
  return report;
}

export function countStatuses(report: Pick<GateReport, 'results'>): GateStatusCounts {
  const counts: GateStatusCounts = { passed: 0, failed: 0, skipped: 0, error: 0, total: 0 };
  for (const r of report.results) {
    counts[r.status]++;
    counts.total++;
  }
  return counts;
}

/** Write `<dir>/gates.json` atomically (tmp file + rename). Returns the path. */
export async function writeGateReport(report: GateReport, dir: string, fileName = GATE_REPORT_FILE): Promise<string> {
  await mkdir(dir, { recursive: true });
  const path = join(dir, fileName);
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tmp, `${JSON.stringify(report, null, 2)}\n`);
  await rename(tmp, path);
  return path;
}

const STATUS_LABEL: Record<GateStatus, string> = {
  passed: 'PASS',
  failed: 'FAIL',
  skipped: 'SKIP',
  error: 'ERR ',
};

/**
 * Last meaningful lines of a command's output, without ANSI colours or blank lines. Shown when a
 * gate failed without file-level issues (a build that crashed, a test runner exit code), so a
 * human or an agent sees the actual error instead of just "exit code 2".
 */
export function outputExcerpt(output: string | undefined, maxLines = 15): string[] {
  if (!output) return [];
  // eslint-disable-next-line no-control-regex
  const clean = output.replace(/\u001b\[[0-9;]*[A-Za-z]/g, '');
  const lines = clean.split(/\r?\n/).map((l) => l.trimEnd()).filter((l) => l.trim() !== '');
  return lines.slice(-maxLines);
}

/** True when the result's error issues point at no file: the output is the only real clue. */
export function needsOutput(r: GateResult): boolean {
  if (r.status !== 'failed' && r.status !== 'error') return false;
  return !r.issues.some((i) => i.severity === 'error' && i.file);
}

function seconds(ms: number): string {
  return `${(ms / 1000).toFixed(1)}s`;
}

/** Plain-text report for the terminal: one line per gate, skipped gates clearly marked. */
export function formatGateReport(report: GateReport, opts: { issuesPerGate?: number } = {}): string {
  const counts = countStatuses(report);
  const width = Math.max(4, ...report.results.map((r) => r.gate.length));
  const lines = [
    `Gates ${report.passed ? 'PASSED' : 'FAILED'}: ${counts.passed} passed, ${counts.failed} failed, ${counts.error} error, ${counts.skipped} skipped`,
  ];
  for (const r of report.results) {
    lines.push(`  ${STATUS_LABEL[r.status]} ${r.gate.padEnd(width)} ${seconds(r.durationMs).padStart(6)}  ${r.summary}`);
    if (r.status === 'failed' || r.status === 'error') {
      for (const issue of r.issues.filter((i) => i.severity === 'error').slice(0, opts.issuesPerGate ?? 5)) {
        const where = issue.file ? `${issue.file}${issue.line ? `:${issue.line}` : ''} ` : '';
        lines.push(`         - ${where}${issue.message}`);
      }
    }
  }
  return lines.join('\n');
}

/**
 * Compact feedback for the executor's retry prompt (`Task.lastError`): only failing gates, their
 * summaries and the first issues. Empty string when the report passed.
 */
export function gateFeedback(report: GateReport, opts: { issuesPerGate?: number; maxChars?: number } = {}): string {
  const failing = report.results.filter((r) => r.blocking ?? (r.status === 'failed' || r.status === 'error'));
  if (failing.length === 0) return '';
  const parts = failing.map((r) => {
    if (r.status === 'skipped') {
      return `[${r.gate}] could not run: ${r.summary.replace(/^SKIPPED:\s*/, '')}\n  - a gate that cannot run counts as failed; make it runnable (e.g. install the missing tool) or ask the user`;
    }
    const issues = r.issues
      .filter((i) => i.severity === 'error')
      .slice(0, opts.issuesPerGate ?? 10)
      .map((i) => `  - ${i.file ? `${i.file}${i.line ? `:${i.line}${i.column ? `:${i.column}` : ''}` : ''}: ` : ''}${i.message}${i.rule ? ` [${i.rule}]` : ''}`);
    const tail = needsOutput(r) ? outputExcerpt(r.output, 20).map((l) => `    | ${l}`) : [];
    return [`[${r.gate}] ${r.summary}`, ...issues, ...(tail.length ? ['  output (last lines):', ...tail] : [])].join('\n');
  });
  const text = parts.join('\n');
  const max = opts.maxChars ?? 6000;
  return text.length > max ? `${text.slice(0, max)}\n…(truncated)` : text;
}
