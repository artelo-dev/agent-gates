/**
 * GitHub Actions workflow commands, so gate failures show up inline on the PR diff.
 * https://docs.github.com/actions/reference/workflow-commands-for-github-actions
 */
import type { GateReport } from '../contracts.js';

/** GitHub renders at most 10 error annotations per step and 50 per job; more is noise. */
export const MAX_ANNOTATIONS = 50;

function escapeData(s: string): string {
  return s.replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
}

function escapeProperty(s: string): string {
  return escapeData(s).replace(/:/g, '%3A').replace(/,/g, '%2C');
}

/** One `::error` line per error issue of every blocking gate; a gate without file issues gets one line for its summary. */
export function githubAnnotations(report: GateReport, max = MAX_ANNOTATIONS): string[] {
  const lines: string[] = [];
  let dropped = 0;
  const push = (props: Record<string, string | number | undefined>, message: string) => {
    if (lines.length >= max) {
      dropped++;
      return;
    }
    const p = Object.entries(props)
      .filter(([, v]) => v !== undefined && v !== '')
      .map(([k, v]) => `${k}=${escapeProperty(String(v))}`)
      .join(',');
    lines.push(`::error ${p}::${escapeData(message)}`);
  };
  for (const r of report.results) {
    if (!(r.blocking ?? (r.status === 'failed' || r.status === 'error'))) continue;
    const title = `agent-gates ${r.gate}`;
    const withFile = r.issues.filter((i) => i.severity === 'error' && i.file);
    if (withFile.length === 0) {
      push({ title }, r.summary);
      continue;
    }
    for (const i of withFile) {
      push({ file: i.file, line: i.line, col: i.column, title }, `${i.message}${i.rule ? ` [${i.rule}]` : ''}`);
    }
  }
  if (dropped > 0) lines.push(`::warning title=agent-gates::${dropped} more problems not annotated; see the report artifact`);
  return lines;
}
