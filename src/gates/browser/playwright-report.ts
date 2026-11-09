/** Parse Playwright's JSON reporter output into pass/fail counts and failure messages. */

export interface PlaywrightFailure {
  title: string;
  message: string;
  file?: string;
  line?: number;
}

export interface PlaywrightSummary {
  total: number;
  passed: number;
  failed: number;
  flaky: number;
  skipped: number;
  failures: PlaywrightFailure[];
}

interface PwError {
  message?: string;
  location?: { file?: string; line?: number };
}
interface PwResult {
  status?: string;
  error?: PwError;
  errors?: PwError[];
}
interface PwTest {
  status?: string;
  results?: PwResult[];
}
interface PwSpec {
  title?: string;
  ok?: boolean;
  file?: string;
  line?: number;
  tests?: PwTest[];
}
interface PwSuite {
  title?: string;
  specs?: PwSpec[];
  suites?: PwSuite[];
}
interface PwReport {
  suites?: PwSuite[];
  errors?: PwError[];
}

// eslint-disable-next-line no-control-regex
const ANSI = /\u001b\[[0-9;]*m/g;

export function cleanMessage(message: string, max = 600): string {
  const text = message.replace(ANSI, '').trim();
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

export function parsePlaywrightReport(json: string): PlaywrightSummary {
  const report = JSON.parse(json) as PwReport;
  const summary: PlaywrightSummary = { total: 0, passed: 0, failed: 0, flaky: 0, skipped: 0, failures: [] };

  const visit = (suite: PwSuite, path: string[]) => {
    const here = suite.title ? [...path, suite.title] : path;
    for (const spec of suite.specs ?? []) {
      for (const t of spec.tests ?? []) {
        summary.total++;
        const status = t.status ?? (spec.ok ? 'expected' : 'unexpected');
        if (status === 'skipped') summary.skipped++;
        else if (status === 'flaky') summary.flaky++;
        else if (status === 'expected') summary.passed++;
        else {
          summary.failed++;
          const results = t.results ?? [];
          const last = results[results.length - 1];
          const err = last?.error ?? last?.errors?.[0];
          const failure: PlaywrightFailure = {
            title: [...here.slice(1), spec.title ?? '(untitled)'].filter(Boolean).join(' › '),
            message: cleanMessage(err?.message ?? `test ${last?.status ?? status}`),
          };
          const file = err?.location?.file ?? spec.file;
          const line = err?.location?.line ?? spec.line;
          if (file) failure.file = file;
          if (line !== undefined) failure.line = line;
          summary.failures.push(failure);
        }
      }
    }
    for (const child of suite.suites ?? []) visit(child, here);
  };
  for (const suite of report.suites ?? []) visit(suite, []);
  for (const err of report.errors ?? []) {
    summary.failed++;
    summary.failures.push({ title: 'playwright', message: cleanMessage(err.message ?? 'unknown error') });
  }
  return summary;
}
