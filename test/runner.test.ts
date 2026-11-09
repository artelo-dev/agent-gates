import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { GateResult, GatesConfig } from '../src/contracts.js';
import { createGateRunner, DEFAULT_GATES_CONFIG } from '../src/index.js';
import type { GateImplementation } from '../src/index.js';
import { FakeExecutor, FakeProbe, FakeServer, makeTempDir, writeFiles } from './helpers.js';

describe('gate runner', () => {
  let root: string;
  let dir: string;
  let artifactsDir: string;
  let cleanup: () => Promise<void>;

  beforeEach(async () => {
    const tmp = await makeTempDir();
    root = tmp.dir;
    dir = join(root, 'project');
    artifactsDir = join(root, 'project', '.artelo', 'runs', 'run-1');
    cleanup = tmp.cleanup;
    await writeFiles(dir, {
      'package.json': JSON.stringify({ scripts: { build: 'next build', start: 'next start' } }),
      'tsconfig.json': '{}',
      'content/home.json': '{"headline": "Ship it"}',
    });
  });
  afterEach(async () => cleanup());

  const ctx = () => ({ runId: 'run-1', taskId: 'T3', cwd: dir, artifactsDir });

  it('runs every gate, aggregates a report and writes runs/<id>/gates.json', async () => {
    const exec = new FakeExecutor();
    const started: string[] = [];
    const finished: GateResult[] = [];
    let tick = 0;
    const runner = createGateRunner({
      exec,
      probe: new FakeProbe({ tsc: '/bin/tsc' }),
      server: new FakeServer(),
      now: () => new Date(Date.UTC(2026, 0, 1, 0, 0, tick++)),
      onGateStart: (g) => started.push(g),
      onGateResult: (r) => finished.push(r),
    });
    const report = await runner.run(['tsc', 'content-lint', 'build', 'lighthouse', 'axe'], DEFAULT_GATES_CONFIG, ctx());
    expect(report.results.map((r) => [r.gate, r.status])).toEqual([
      ['tsc', 'passed'],
      ['content-lint', 'passed'],
      ['build', 'passed'],
      ['lighthouse', 'skipped'],
      ['axe', 'skipped'],
    ]);
    // lighthouse / axe are blocking in the landing config: skipped (tools missing) fails the report.
    expect(report).toMatchObject({ runId: 'run-1', taskId: 'T3', passed: false, startedAt: '2026-01-01T00:00:00.000Z', finishedAt: '2026-01-01T00:00:01.000Z' });
    expect(report.results.every((r) => typeof r.durationMs === 'number')).toBe(true);
    expect(started).toEqual(['tsc', 'content-lint', 'build', 'lighthouse', 'axe']);
    expect(finished).toEqual(report.results);
    const written = JSON.parse(await readFile(join(artifactsDir, 'gates.json'), 'utf8'));
    expect(written).toEqual(report);
  });

  it('uses enabled gates from config when the gate list is empty', async () => {
    const config: GatesConfig = { gates: { 'content-lint': {}, tsc: { enabled: false } } };
    const report = await createGateRunner({ exec: new FakeExecutor(), probe: new FakeProbe(), server: new FakeServer() }).run([], config, ctx());
    expect(report.results.map((r) => r.gate)).toEqual(['content-lint']);
  });

  it('reports disabled gates as skipped and unknown gates as errors', async () => {
    const config: GatesConfig = { gates: { tsc: { enabled: false } } };
    const report = await createGateRunner({ exec: new FakeExecutor(), probe: new FakeProbe(), server: new FakeServer() }).run(['tsc', 'nonsense'], config, ctx());
    expect(report.results[0]).toMatchObject({ status: 'skipped', summary: 'SKIPPED: disabled in gates.yaml' });
    expect(report.results[1]).toMatchObject({ gate: 'nonsense', status: 'error' });
    expect(report.passed).toBe(false);
  });

  // Regression: with an empty config (the orchestrator's old fallback) allowSkip defaulted to true, so a
  // missing lighthouse binary was "skipped" and the report passed.
  it('fails the report when a gate is skipped for a missing tool under an empty config', async () => {
    const report = await createGateRunner({ exec: new FakeExecutor(), probe: new FakeProbe(), server: new FakeServer() }).run(
      ['lighthouse'],
      { gates: {} },
      ctx(),
    );
    expect(report.results[0]?.status).toBe('skipped');
    expect(report.passed).toBe(false);
  });

  it('never blocks on a gate disabled in gates.yaml', async () => {
    const config: GatesConfig = { gates: { 'content-lint': {}, tsc: { enabled: false } } };
    const report = await createGateRunner({ exec: new FakeExecutor(), probe: new FakeProbe(), server: new FakeServer() }).run(['tsc'], config, ctx());
    expect(report.results[0]).toMatchObject({ gate: 'tsc', status: 'skipped' });
    expect(report.passed).toBe(true);
  });

  it('runs custom gates that only define a command', async () => {
    const exec = new FakeExecutor().on('check-links', () => ({ exitCode: 3 }));
    const config: GatesConfig = { gates: { links: { command: 'node scripts/check-links.mjs' } } };
    const report = await createGateRunner({ exec, probe: new FakeProbe(), server: new FakeServer() }).run(['links'], config, ctx());
    expect(exec.argvs()).toEqual(['node scripts/check-links.mjs']);
    expect(report.results[0]).toMatchObject({ gate: 'links', status: 'failed' });
  });

  it('fails the report when a skipped gate has allowSkip: false (landing preset playwright)', async () => {
    const report = await createGateRunner({ exec: new FakeExecutor(), probe: new FakeProbe(), server: new FakeServer() }).run(
      ['playwright'],
      DEFAULT_GATES_CONFIG,
      { ...ctx(), spec: { version: 1, recipe: 'landing', project: {} as never, brand: {} as never, stack: { framework: 'next' }, pages: [{ id: 'home', route: '/', sections: [{ id: 'hero' }] }] } },
    );
    expect(report.results[0]?.status).toBe('skipped');
    expect(report.results[0]?.summary).toMatch(/@playwright\/test is not installed/);
    expect(report.passed).toBe(false);
  });

  it('a non-required failing gate does not fail the report', async () => {
    const exec = new FakeExecutor().on('run build', () => ({ exitCode: 1 }));
    const report = await createGateRunner({ exec, probe: new FakeProbe(), server: new FakeServer() }).run(['build'], { gates: { build: { required: false } } }, ctx());
    expect(report.results[0]?.status).toBe('failed');
    expect(report.passed).toBe(true);
  });

  it('skips browser gates when the build failed, without starting the server', async () => {
    const exec = new FakeExecutor().on('run build', () => ({ exitCode: 1 }));
    const server = new FakeServer();
    const report = await createGateRunner({
      exec,
      probe: new FakeProbe({ lighthouse: '/bin/lighthouse' }, ['@playwright/test', '@axe-core/playwright']),
      server,
    }).run(['build', 'axe', 'lighthouse'], { gates: {} }, ctx());
    expect(report.results.map((r) => [r.gate, r.status])).toEqual([
      ['build', 'failed'],
      ['axe', 'skipped'],
      ['lighthouse', 'skipped'],
    ]);
    expect(report.results[1]?.summary).toBe('SKIPPED: blocked: the build gate did not pass');
    expect(server.starts).toHaveLength(0);
    expect(report.passed).toBe(false);
  });

  it('turns a crashing gate into an error result and keeps going', async () => {
    const boom: GateImplementation = {
      id: 'tsc',
      run: async () => {
        throw new Error('kaboom');
      },
    };
    const report = await createGateRunner({ exec: new FakeExecutor(), probe: new FakeProbe(), server: new FakeServer(), gates: [boom] }).run(
      ['tsc', 'content-lint'],
      { gates: {} },
      ctx(),
    );
    expect(report.results[0]).toMatchObject({ status: 'error', summary: 'gate crashed: kaboom' });
    expect(report.results[1]?.status).toBe('passed');
  });

  it('marks remaining gates as errors after an abort (an aborted run never passes)', async () => {
    const controller = new AbortController();
    const first: GateImplementation = {
      id: 'tsc',
      run: async () => {
        controller.abort();
        return { status: 'passed', summary: 'ok', issues: [] };
      },
    };
    const report = await createGateRunner({ exec: new FakeExecutor(), probe: new FakeProbe(), server: new FakeServer(), gates: [first] }).run(
      ['tsc', 'content-lint'],
      { gates: {} },
      { ...ctx(), signal: controller.signal },
    );
    expect(report.results.map((r) => r.status)).toEqual(['passed', 'error']);
    expect(report.passed).toBe(false);
  });

  it('starts the preview server once for several browser gates, stops it, and removes scratch files', async () => {
    const server = new FakeServer();
    const exec = new FakeExecutor();
    const report = await createGateRunner({ exec, probe: new FakeProbe({}, ['@playwright/test', '@axe-core/playwright']), server }).run(
      ['axe', 'visual'],
      { gates: {}, server: { port: 4999 } } as GatesConfig,
      ctx(),
    );
    expect(server.starts).toHaveLength(1);
    expect(server.starts[0]).toMatchObject({ url: 'http://127.0.0.1:4999', port: 4999, command: { command: 'npm', args: ['run', 'start'] } });
    expect(server.stops).toBe(1);
    // the fake playwright wrote no report → the gates error out, but scratch files are gone
    expect(report.results.map((r) => r.status)).toEqual(['error', 'error']);
    const arteloEntries = await readdir(join(dir, '.artelo'));
    expect(arteloEntries).toEqual(['runs']);
  });

  it('skips browser gates when no preview server can be started', async () => {
    await writeFiles(dir, { 'package.json': JSON.stringify({ scripts: {} }) });
    const report = await createGateRunner({ exec: new FakeExecutor(), probe: new FakeProbe({}, ['@playwright/test']), server: new FakeServer() }).run(
      ['visual'],
      { gates: {} },
      ctx(),
    );
    expect(report.results[0]).toMatchObject({ status: 'skipped' });
    expect(report.results[0]?.summary).toMatch(/no preview server/);
  });

  it('reports a preview server that fails to come up as an error', async () => {
    const report = await createGateRunner({
      exec: new FakeExecutor(),
      probe: new FakeProbe({}, ['@playwright/test']),
      server: new FakeServer('server exited early (code 1)'),
    }).run(['visual'], { gates: {} }, ctx());
    expect(report.results[0]).toMatchObject({ status: 'error', summary: 'preview server: server exited early (code 1)' });
  });
});
