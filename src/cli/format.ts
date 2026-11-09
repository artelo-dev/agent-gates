/** Terminal output: one line per gate as it finishes, then a verdict line. */
import type { GateReport, GateResult, GateStatus } from '../contracts.js';
import { countStatuses, needsOutput, outputExcerpt } from '../report.js';

export interface Style {
  color: boolean;
}

const CODES = { red: 31, green: 32, yellow: 33, gray: 90, bold: 1 } as const;

export function paint(style: Style, code: keyof typeof CODES, text: string): string {
  return style.color ? `\u001b[${CODES[code]}m${text}\u001b[0m` : text;
}

const SYMBOL: Record<GateStatus, string> = { passed: '✓', failed: '✗', error: '!', skipped: '○' };
const SYMBOL_COLOR: Record<GateStatus, keyof typeof CODES> = { passed: 'green', failed: 'red', error: 'red', skipped: 'yellow' };

export const GATE_COLUMN = 13;

function seconds(ms: number): string {
  return `${(ms / 1000).toFixed(1)}s`;
}

/** The line(s) printed when one gate finishes. Failing gates list their first issues. */
export function formatGateLine(result: GateResult, style: Style, issuesPerGate = 5): string {
  const color = result.status === 'skipped' && result.blocking ? 'red' : SYMBOL_COLOR[result.status];
  const head = `${paint(style, color, SYMBOL[result.status])} ${result.gate.padEnd(GATE_COLUMN)}${paint(style, 'gray', seconds(result.durationMs).padStart(6))}  ${result.summary}`;
  if (result.status !== 'failed' && result.status !== 'error') return head;
  const errors = result.issues.filter((i) => i.severity === 'error');
  const lines = [head];
  for (const issue of errors.slice(0, issuesPerGate)) {
    const where = issue.file ? `${issue.file}${issue.line ? `:${issue.line}` : ''}  ` : '';
    lines.push(`    ${paint(style, 'gray', where)}${issue.message}${issue.rule ? paint(style, 'gray', ` [${issue.rule}]`) : ''}`);
  }
  if (errors.length > issuesPerGate) lines.push(paint(style, 'gray', `    … ${errors.length - issuesPerGate} more`));
  if (needsOutput(result)) for (const l of outputExcerpt(result.output, 10)) lines.push(paint(style, 'gray', `    │ ${l}`));
  return lines.join('\n');
}

export function formatVerdict(report: GateReport, style: Style, reportPath?: string): string {
  const c = countStatuses(report);
  const parts = [`${c.passed} passed`];
  if (c.failed) parts.push(`${c.failed} failed`);
  if (c.error) parts.push(`${c.error} error`);
  if (c.skipped) parts.push(`${c.skipped} skipped`);
  const verdict = report.passed ? paint(style, 'green', paint(style, 'bold', 'PASSED')) : paint(style, 'red', paint(style, 'bold', 'FAILED'));
  const why = !report.passed && c.failed === 0 && c.error === 0 && c.skipped > 0 ? ' · a skipped gate counts as failed (allowSkip: false)' : '';
  return `${verdict} · ${parts.join(', ')}${why}${reportPath ? paint(style, 'gray', ` · report: ${reportPath}`) : ''}`;
}
