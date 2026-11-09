import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { GatesConfig } from '../src/contracts.js';
import { createGateRunner, parseEslintJson, parseTscOutput } from '../src/index.js';
import { FakeExecutor, FakeProbe, FakeServer, makeTempDir, writeFiles } from './helpers.js';

describe('parsers', () => {
  it('parses tsc --pretty false diagnostics', () => {
    const issues = parseTscOutput(
      [
        "src/a.ts(3,7): error TS2322: Type 'string' is not assignable to type 'number'.",
        'src/b.tsx:10:2 - error TS2304: Cannot find name \'x\'.',
        "error TS5058: The specified path does not exist: 'tsconfig.json'.",
        'Found 3 errors.',
      ].join('\n'),
    );
    expect(issues).toEqual([
      { severity: 'error', file: 'src/a.ts', line: 3, column: 7, rule: 'TS2322', message: "Type 'string' is not assignable to type 'number'." },
      { severity: 'error', file: 'src/b.tsx', line: 10, column: 2, rule: 'TS2304', message: "Cannot find name 'x'." },
      { severity: 'error', rule: 'TS5058', message: "The specified path does not exist: 'tsconfig.json'." },
    ]);
  });

  it('parses eslint json output and makes paths relative', () => {
    const stdout = `> lint\n${JSON.stringify([
      {
        filePath: '/proj/src/a.ts',
        messages: [
          { ruleId: 'no-unused-vars', severity: 2, message: "'x' is unused", line: 1, column: 7 },
          { ruleId: 'prefer-const', severity: 1, message: 'use const', line: 2, column: 1 },
        ],
      },
      { filePath: '/proj/src/b.ts', messages: [] },
    ])}\n`;
    const parsed = parseEslintJson(stdout, '/proj');
    expect(parsed?.errors).toBe(1);
    expect(parsed?.warnings).toBe(1);
    expect(parsed?.issues[0]).toEqual({ severity: 'error', file: 'src/a.ts', line: 1, column: 7, rule: 'no-unused-vars', message: "'x' is unused" });
    expect(parseEslintJson('not json', '/proj')).toBeUndefined();
  });
});

describe('command gates through the runner (fake executor)', () => {
  let dir: string;
  let artifactsDir: string;
  let cleanup: () => Promise<void>;

  beforeEach(async () => {
    const tmp = await makeTempDir();
    dir = `${tmp.dir}/project`;
    artifactsDir = `${tmp.dir}/runs/r1`;
    cleanup = tmp.cleanup;
  });
  afterEach(async () => cleanup());

  const run = (exec: FakeExecutor, gates: string[], config: GatesConfig = { gates: {} }) =>
    createGateRunner({ exec, probe: new FakeProbe({ tsc: '/bin/tsc', eslint: '/bin/eslint' }), server: new FakeServer() }).run(gates, config, {
      runId: 'r1',
      cwd: dir,
      artifactsDir,
    });

  it('skips tsc/eslint/build/tests when the project has nothing to run', async () => {
    await writeFiles(dir, { 'package.json': JSON.stringify({ scripts: { test: 'echo "Error: no test specified" && exit 1' } }) });
    const exec = new FakeExecutor();
    const report = await run(exec, ['typecheck', 'eslint', 'build', 'tests']);
    expect(report.results.map((r) => [r.gate, r.status])).toEqual([
      ['tsc', 'skipped'],
      ['eslint', 'skipped'],
      ['build', 'skipped'],
      ['tests', 'skipped'],
    ]);
    expect(report.results.every((r) => r.summary.startsWith('SKIPPED: '))).toBe(true);
    expect(exec.calls).toHaveLength(0);
    // Fail closed: nothing ran, so nothing was verified.
    expect(report.passed).toBe(false);
    const lenient = await run(new FakeExecutor(), ['typecheck', 'eslint', 'build', 'tests'], {
      gates: { tsc: { allowSkip: true }, eslint: { allowSkip: true }, build: { allowSkip: true }, tests: { allowSkip: true } },
    });
    expect(lenient.passed).toBe(true);
  });

  it('runs tsc with the local bin and fails on type errors', async () => {
    await writeFiles(dir, { 'tsconfig.json': '{}', 'package.json': '{}' });
    const exec = new FakeExecutor().on('/bin/tsc', () => ({
      exitCode: 2,
      stdout: "src/a.ts(1,1): error TS2322: bad\nsrc/b.ts(2,2): error TS2304: worse\n",
    }));
    const report = await run(exec, ['tsc']);
    expect(exec.argvs()).toEqual(['/bin/tsc --noEmit --pretty false -p tsconfig.json']);
    expect(exec.calls[0]?.opts.cwd).toBe(dir);
    const tsc = report.results[0];
    expect(tsc).toMatchObject({ gate: 'tsc', status: 'failed', summary: '2 type errors', metrics: { errors: 2 }, thresholds: { errors: 0 } });
    expect(tsc?.issues).toHaveLength(2);
    expect(report.passed).toBe(false);
  });

  it('fails tsc when it exits non-zero without parseable diagnostics', async () => {
    await writeFiles(dir, { 'tsconfig.json': '{}' });
    const exec = new FakeExecutor().on('tsc', () => ({ exitCode: 1, stderr: 'segfault' }));
    const report = await run(exec, ['tsc']);
    expect(report.results[0]).toMatchObject({ status: 'failed', output: 'segfault' });
  });

  it('runs eslint with JSON output and evaluates error thresholds', async () => {
    await writeFiles(dir, { 'eslint.config.js': 'export default [];' });
    const json = JSON.stringify([{ filePath: `${dir}/a.ts`, messages: [{ severity: 1, message: 'meh', ruleId: 'r' }] }]);
    const exec = new FakeExecutor().on('/bin/eslint', () => ({ exitCode: 0, stdout: json }));
    const report = await run(exec, ['lint']);
    expect(exec.argvs()).toEqual(['/bin/eslint . --format json']);
    expect(report.results[0]).toMatchObject({ gate: 'eslint', status: 'passed', metrics: { errors: 0, warnings: 1 }, summary: '0 errors, 1 warning' });

    const failing = new FakeExecutor().on('eslint', () => ({
      exitCode: 1,
      stdout: JSON.stringify([{ filePath: `${dir}/a.ts`, messages: [{ severity: 2, message: 'bad', ruleId: 'r', line: 4 }] }]),
    }));
    const failed = await run(failing, ['eslint']);
    expect(failed.results[0]).toMatchObject({ status: 'failed', summary: '1 lint error, 0 warnings' });
    expect(failed.results[0]?.issues[0]).toMatchObject({ file: 'a.ts', line: 4, rule: 'r' });
  });

  it('runs the build script with the detected package manager and a configured command override', async () => {
    await writeFiles(dir, { 'pnpm-lock.yaml': '', 'package.json': JSON.stringify({ scripts: { build: 'next build', test: 'vitest run' } }) });
    const exec = new FakeExecutor().on('pnpm run test', () => ({ exitCode: 1, stdout: '1 failed' }));
    const report = await run(exec, ['build', 'tests']);
    expect(exec.argvs()).toEqual(['pnpm run build', 'pnpm run test']);
    expect(report.results.map((r) => r.status)).toEqual(['passed', 'failed']);
    expect(report.results[1]?.summary).toBe('tests failed: `pnpm run test` exited with code 1');

    const custom = new FakeExecutor();
    await run(custom, ['build'], { gates: { build: { command: 'npm run build:prod -- --flag "two words"' } } } as never);
    expect(custom.calls[0]?.cmd).toEqual({ command: 'npm', args: ['run', 'build:prod', '--', '--flag', 'two words'] });
  });

  it('maps timeouts, spawn errors and per-gate timeouts', async () => {
    await writeFiles(dir, { 'package.json': JSON.stringify({ scripts: { build: 'x', test: 'y' } }) });
    const exec = new FakeExecutor()
      .on('run build', () => ({ exitCode: null, timedOut: true, durationMs: 3000 }))
      .on('run test', () => ({ exitCode: null, spawnError: 'spawn npm ENOENT' }));
    const report = await run(exec, ['build', 'tests'], { gates: { build: { timeoutMs: 3000 } } } as never);
    expect(exec.calls[0]?.opts.timeoutMs).toBe(3000);
    expect(report.results[0]).toMatchObject({ status: 'failed', summary: '`npm run build` timed out after 3s' });
    expect(report.results[1]).toMatchObject({ status: 'error' });
    expect(report.results[1]?.summary).toMatch(/could not start `npm run test`: spawn npm ENOENT/);
  });
});
