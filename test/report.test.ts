import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { GateResult } from '../src/contracts.js';
import { aggregateReport, countStatuses, formatGateReport, gateFeedback, isBlocking, writeGateReport } from '../src/index.js';
import { makeTempDir } from './helpers.js';

const result = (gate: string, status: GateResult['status'], extra: Partial<GateResult> = {}): GateResult => ({
  gate,
  status,
  summary: status === 'skipped' ? 'SKIPPED: tool missing' : `${gate} ${status}`,
  durationMs: 1200,
  issues: [],
  ...extra,
});

const base = { runId: 'r1', startedAt: '2026-01-01T00:00:00.000Z', finishedAt: '2026-01-01T00:00:05.000Z' };

describe('report aggregation', () => {
  it('passes when every required gate passed or was skipped where skipping is allowed', () => {
    const report = aggregateReport({
      ...base,
      results: [result('tsc', 'passed'), result('lighthouse', 'skipped')],
      policies: { lighthouse: { required: true, allowSkip: true } },
    });
    expect(report.passed).toBe(true);
    expect(report.taskId).toBeUndefined();
  });

  // Regression: without a policy a skipped gate counted as passed (default allowSkip: true).
  it('fails closed: a skipped gate without an explicit policy blocks the report', () => {
    expect(isBlocking(result('lighthouse', 'skipped'))).toBe(true);
    expect(aggregateReport({ ...base, results: [result('tsc', 'passed'), result('lighthouse', 'skipped')] }).passed).toBe(false);
  });

  it('fails on failed or error results of required gates', () => {
    expect(aggregateReport({ ...base, results: [result('tsc', 'failed')] }).passed).toBe(false);
    expect(aggregateReport({ ...base, results: [result('axe', 'error')] }).passed).toBe(false);
  });

  it('ignores failures of non-required gates', () => {
    const report = aggregateReport({
      ...base,
      results: [result('tsc', 'passed'), result('lighthouse', 'failed')],
      policies: { lighthouse: { required: false, allowSkip: true } },
    });
    expect(report.passed).toBe(true);
  });

  it('fails a skipped gate whose policy disallows skipping', () => {
    const policy = { required: true, allowSkip: false };
    expect(isBlocking(result('playwright', 'skipped'), policy)).toBe(true);
    expect(aggregateReport({ ...base, taskId: 't1', results: [result('playwright', 'skipped')], policies: { playwright: policy } })).toMatchObject({
      passed: false,
      taskId: 't1',
    });
  });

  it('counts statuses with skipped distinct from passed', () => {
    const report = aggregateReport({
      ...base,
      results: [result('tsc', 'passed'), result('eslint', 'failed'), result('axe', 'skipped'), result('lighthouse', 'skipped'), result('x', 'error')],
    });
    expect(countStatuses(report)).toEqual({ passed: 1, failed: 1, skipped: 2, error: 1, total: 5 });
  });
});

describe('report formatting', () => {
  const report = aggregateReport({
    ...base,
    results: [
      result('tsc', 'passed', { summary: 'no type errors' }),
      result('content-lint', 'failed', {
        summary: '1 content problem (lorem: 1)',
        issues: [{ severity: 'error', message: 'lorem ipsum placeholder text', file: 'content/home.json', line: 3, column: 5, rule: 'lorem' }],
      }),
      result('lighthouse', 'skipped', { summary: 'SKIPPED: lighthouse is not installed' }),
    ],
  });

  it('formats one line per gate and marks skipped gates explicitly', () => {
    const text = formatGateReport(report);
    expect(text.split('\n')[0]).toBe('Gates FAILED: 1 passed, 1 failed, 0 error, 1 skipped');
    expect(text).toMatch(/PASS tsc\s+1\.2s {2}no type errors/);
    expect(text).toMatch(/FAIL content-lint/);
    expect(text).toMatch(/SKIP lighthouse\s+1\.2s {2}SKIPPED: lighthouse is not installed/);
    expect(text).toContain('- content/home.json:3 lorem ipsum placeholder text');
  });

  it('builds retry feedback from blocking gates, including a skipped gate that may not skip', () => {
    const feedback = gateFeedback(report);
    expect(feedback).toBe(
      '[content-lint] 1 content problem (lorem: 1)\n  - content/home.json:3:5: lorem ipsum placeholder text [lorem]\n' +
        '[lighthouse] could not run: lighthouse is not installed\n' +
        '  - a gate that cannot run counts as failed; make it runnable (e.g. install the missing tool) or ask the user',
    );
    expect(gateFeedback(aggregateReport({ ...base, results: [result('tsc', 'passed')] }))).toBe('');
  });

  it('leaves out a skipped gate whose policy allows skipping', () => {
    const allowed = aggregateReport({
      ...base,
      results: [result('lighthouse', 'skipped', { summary: 'SKIPPED: no chrome' })],
      policies: { lighthouse: { required: true, allowSkip: true } },
    });
    expect(allowed.passed).toBe(true);
    expect(allowed.results[0]?.blocking).toBe(false);
    expect(gateFeedback(allowed)).toBe('');
  });
});

describe('writeGateReport', () => {
  let cleanup: (() => Promise<void>) | undefined;
  afterEach(async () => {
    await cleanup?.();
  });

  it('writes runs/<id>/gates.json atomically', async () => {
    const tmp = await makeTempDir();
    cleanup = tmp.cleanup;
    const dir = join(tmp.dir, 'runs', 'r1');
    const report = aggregateReport({ ...base, results: [result('tsc', 'passed')] });
    const path = await writeGateReport(report, dir);
    expect(path).toBe(join(dir, 'gates.json'));
    expect(JSON.parse(await readFile(path, 'utf8'))).toEqual(report);
  });
});

describe('output excerpt for failures without file-level issues', () => {
  it('feeds the tail of the command output to the agent', async () => {
    const { aggregateReport: agg, gateFeedback: fb } = await import('../src/index.js');
    const report = agg({
      runId: 'r',
      startedAt: 't',
      finishedAt: 't',
      results: [
        {
          gate: 'build',
          status: 'failed',
          summary: 'build failed',
          durationMs: 1,
          issues: [{ severity: 'error', message: 'exit code 2' }],
          output: '> build\n\n\u001b[91merror\u001b[0m TS5011: rootDir must be set\n',
        },
      ],
    });
    expect(fb(report)).toBe('[build] build failed\n  - exit code 2\n  output (last lines):\n    | > build\n    | error TS5011: rootDir must be set');
  });
});
