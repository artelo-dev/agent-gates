import { execFile } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { parse as parseYaml } from 'yaml';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Spec } from '../src/contracts.js';
import {
  buildSmokePlan,
  createGateRunner,
  generateAxeTest,
  generatePlaywrightConfig,
  generateSmokeTest,
  generateVisualTest,
  parseLighthouse,
  parsePlaywrightReport,
  resolveRoutes,
  sampleFromPlaceholder,
} from '../src/index.js';
import type { CommandSpec, ExecOptions } from '../src/index.js';
import { FakeExecutor, FakeProbe, FakeServer, argValue, makeTempDir, writeFiles } from './helpers.js';

const run = promisify(execFile);
const specPath = fileURLToPath(new URL('./fixtures/landing.spec.yaml', import.meta.url));
const loadSpec = async () => parseYaml(await readFile(specPath, 'utf8')) as Spec;

const LANDING_SECTIONS = ['nav', 'hero', 'services', 'how-it-works', 'pricing', 'faq', 'booking', 'footer'];
const BOOKING_SUCCESS = 'Thanks! We will reply within one working day to arrange the visit.';

/** Playwright JSON report with the given test outcomes. */
function pwReport(tests: Array<{ title: string; ok: boolean; message?: string }>) {
  return JSON.stringify({
    suites: [
      {
        title: 'agent-gates-smoke.spec.mjs',
        specs: tests.map((t) => ({
          title: t.title,
          ok: t.ok,
          file: 'agent-gates-smoke.spec.mjs',
          line: 10,
          tests: [{ status: t.ok ? 'expected' : 'unexpected', results: [{ status: t.ok ? 'passed' : 'failed', ...(t.message ? { error: { message: t.message } } : {}) }] }],
        })),
      },
    ],
    errors: [],
  });
}

describe('smoke test generation from the spec', () => {
  it('collects every section and the booking form from the landing spec', async () => {
    const plan = buildSmokePlan(await loadSpec());
    expect(plan.pages).toEqual([{ id: 'home', route: '/', sections: LANDING_SECTIONS }]);
    expect(plan.forms).toEqual([
      {
        page: 'home',
        route: '/',
        section: 'booking',
        fields: [{ name: 'name', type: 'text', required: true }, { name: 'email', type: 'email', required: true }, { name: 'dog_size', type: 'select' }, { name: 'notes', type: 'textarea' }],
        success: BOOKING_SUCCESS,
      },
    ]);
  });

  it('generates syntactically valid ESM for smoke, axe, visual and config', async () => {
    const tmp = await makeTempDir();
    try {
      const plan = buildSmokePlan(await loadSpec());
      const routes = resolveRoutes(await loadSpec());
      const files = {
        'smoke.mjs': generateSmokeTest(plan, { outDir: tmp.dir }),
        'axe.mjs': generateAxeTest(routes, { outDir: tmp.dir }),
        'visual.mjs': generateVisualTest(routes, { outDir: tmp.dir, viewports: [375, 768, 1440] }),
        'config.mjs': generatePlaywrightConfig({ testFile: 'agent-gates-smoke.spec.mjs', baseURL: 'http://127.0.0.1:3100', jsonReport: join(tmp.dir, 'r.json'), outputDir: tmp.dir }),
      };
      for (const [name, source] of Object.entries(files)) {
        await writeFile(join(tmp.dir, name), source);
        await run(process.execPath, ['--check', join(tmp.dir, name)]);
      }
      expect(files['smoke.mjs']).toContain('"how-it-works"');
      expect(files['smoke.mjs']).toContain(JSON.stringify(BOOKING_SUCCESS));
      expect(files['visual.mjs']).toContain('const WIDTHS = [375,768,1440];');
    } finally {
      await tmp.cleanup();
    }
  });

  it('takes the smoke sample from a placeholder only when it is an example', () => {
    expect(sampleFromPlaceholder('Mila, Border Collie')).toBe('Mila, Border Collie');
    expect(sampleFromPlaceholder('e.g. Graça')).toBe('Graça');
    expect(sampleFromPlaceholder('Such as: Mila, Border Collie…')).toBe('Mila, Border Collie');
    expect(sampleFromPlaceholder('Your name')).toBeNull();
    expect(sampleFromPlaceholder('Enter your email')).toBeNull();
    expect(sampleFromPlaceholder('')).toBeNull();
    expect(sampleFromPlaceholder(null)).toBeNull();
    const plan = { pages: [], forms: [] };
    const src = generateSmokeTest(plan, { outDir: '/tmp/x' });
    expect(src).toContain('function sampleFromPlaceholder(');
    expect(src).toContain('submit sent no POST within 10s');
  });

  it('resolves routes from config, else spec pages (skipping dynamic ones), else /', () => {
    const spec = { pages: [{ id: 'home', route: '/', sections: [] }, { id: 'post', route: '/blog/[slug]', sections: [] }, { id: 'about', route: '/about', sections: [] }] } as unknown as Spec;
    expect(resolveRoutes(spec)).toEqual([{ id: 'home', route: '/' }, { id: 'about', route: '/about' }]);
    expect(resolveRoutes(spec, ['/pricing', 'docs/intro'])).toEqual([{ id: 'pricing', route: '/pricing' }, { id: 'docs-intro', route: '/docs/intro' }]);
    expect(resolveRoutes(undefined)).toEqual([{ id: 'home', route: '/' }]);
  });
});

describe('report parsers', () => {
  it('parses Playwright JSON reports', () => {
    const summary = parsePlaywrightReport(pwReport([{ title: 'a', ok: true }, { title: 'b', ok: false, message: '\u001b[31mexpected 1\u001b[39m' }]));
    expect(summary).toMatchObject({ total: 2, passed: 1, failed: 1 });
    expect(summary.failures).toEqual([{ title: 'b', message: 'expected 1', file: 'agent-gates-smoke.spec.mjs', line: 10 }]);
    expect(parsePlaywrightReport(JSON.stringify({ suites: [], errors: [{ message: 'config broken' }] })).failed).toBe(1);
  });

  it('parses Lighthouse results into 0-100 scores with failing audits', () => {
    const lhr = {
      categories: {
        performance: { score: 0.87, auditRefs: [{ id: 'lcp', weight: 25 }, { id: 'cls', weight: 25 }] },
        accessibility: { score: 1, auditRefs: [] },
        seo: { score: null },
      },
      audits: { lcp: { title: 'Largest Contentful Paint', score: 0.4, displayValue: '4.1 s' }, cls: { title: 'CLS', score: 1 } },
    };
    expect(parseLighthouse(JSON.stringify(lhr))).toEqual({
      scores: { performance: 87, accessibility: 100 },
      failingAudits: { performance: ['Largest Contentful Paint (4.1 s)'], accessibility: [], seo: [] },
    });
  });
});

describe('browser gates (fake playwright / lighthouse)', () => {
  let dir: string;
  let artifactsDir: string;
  let cleanup: () => Promise<void>;
  let spec: Spec;

  beforeEach(async () => {
    const tmp = await makeTempDir();
    dir = join(tmp.dir, 'project');
    artifactsDir = join(tmp.dir, 'runs', 'r1');
    cleanup = tmp.cleanup;
    spec = await loadSpec();
    await writeFiles(dir, { 'package.json': JSON.stringify({ scripts: { start: 'next start' } }) });
  });
  afterEach(async () => cleanup());

  const probe = () => new FakeProbe({ playwright: '/bin/playwright', lighthouse: '/bin/lighthouse' }, ['@playwright/test', '@axe-core/playwright']);
  const ctx = () => ({ runId: 'r1', cwd: dir, artifactsDir, spec });

  /** Fake `playwright test`: checks the generated files exist, then writes what a real run would. */
  const fakePlaywright =
    (write: (outDir: string) => Promise<void>, tests: Array<{ title: string; ok: boolean; message?: string }>) =>
    async (cmd: CommandSpec, opts: ExecOptions) => {
      const configPath = argValue(cmd.args, '--config') as string;
      const config = await readFile(configPath, 'utf8');
      expect(config).toContain('"baseURL": "http://127.0.0.1:3100"');
      expect(configPath.startsWith(join(dir, '.agent-gates', 'tmp'))).toBe(true);
      const reportPath = opts.env?.PLAYWRIGHT_JSON_OUTPUT_NAME as string;
      await mkdir(dirname(reportPath), { recursive: true });
      await write(dirname(reportPath));
      await writeFile(reportPath, pwReport(tests));
      return { exitCode: tests.every((t) => t.ok) ? 0 : 1 };
    };

  it('playwright smoke passes when every section is present and the form submits', async () => {
    const exec = new FakeExecutor().on(
      '/bin/playwright test',
      fakePlaywright(async (out) => {
        await writeFile(join(out, 'sections-home.json'), JSON.stringify({ route: '/', expected: LANDING_SECTIONS, missing: [] }));
      }, [{ title: 'page home', ok: true }, { title: 'form booking', ok: true }]),
    );
    const server = new FakeServer();
    const report = await createGateRunner({ exec, probe: probe(), server }).run(['smoke'], { gates: {} }, ctx());
    expect(report.results[0]).toMatchObject({
      gate: 'playwright',
      status: 'passed',
      summary: '2 smoke tests passed (8 sections, 1 form)',
      metrics: { failures: 0, tests: 2, sectionsExpected: 8, sectionsMissing: 0, forms: 1 },
      artifacts: ['smoke/agent-gates-smoke.spec.mjs', 'smoke/playwright-report.json'],
    });
    expect(await readFile(join(artifactsDir, 'smoke', 'agent-gates-smoke.spec.mjs'), 'utf8')).toContain('"pricing"');
    expect(server.starts[0]).toMatchObject({ cwd: dir, port: 3100, command: { command: 'npm', args: ['run', 'start'] } });
    expect(server.stops).toBe(1);
  });

  it('playwright smoke fails with the missing sections listed', async () => {
    const exec = new FakeExecutor().on(
      'playwright test',
      fakePlaywright(async (out) => {
        await writeFile(join(out, 'sections-home.json'), JSON.stringify({ route: '/', expected: LANDING_SECTIONS, missing: ['faq', 'booking'] }));
      }, [{ title: 'page home', ok: false, message: 'sections missing' }, { title: 'form booking', ok: false, message: 'form not visible' }]),
    );
    const report = await createGateRunner({ exec, probe: probe(), server: new FakeServer() }).run(['playwright'], { gates: {} }, ctx());
    const r = report.results[0];
    expect(r).toMatchObject({ status: 'failed', summary: '2 smoke tests failed; 2 sections missing' });
    expect(r?.issues.map((i) => i.message)).toEqual(
      expect.arrayContaining(['[data-section="faq"] missing on /', '[data-section="booking"] missing on /', 'form booking: form not visible']),
    );
    expect(report.passed).toBe(false);
  });

  it('playwright smoke is skipped (not passed) when browsers are not installed', async () => {
    const exec = new FakeExecutor().on('playwright test', () => ({ exitCode: 1, stderr: "browserType.launch: Executable doesn't exist at /x/chrome" }));
    const report = await createGateRunner({ exec, probe: probe(), server: new FakeServer() }).run(['playwright'], { gates: {} }, ctx());
    expect(report.results[0]).toMatchObject({ status: 'skipped' });
    expect(report.results[0]?.summary).toMatch(/^SKIPPED: Playwright browsers not installed/);
  });

  it('axe counts violations by impact and fails on critical/serious', async () => {
    const exec = new FakeExecutor().on(
      'playwright test',
      fakePlaywright(async (out) => {
        await writeFile(
          join(out, 'axe-home.json'),
          JSON.stringify({
            route: '/',
            violations: [
              { id: 'color-contrast', impact: 'serious', help: 'Elements must have sufficient color contrast', count: 3, targets: ['.cta'] },
              { id: 'region', impact: 'moderate', help: 'Content should be in landmarks', count: 1 },
            ],
          }),
        );
      }, [{ title: 'axe /', ok: true }]),
    );
    const report = await createGateRunner({ exec, probe: probe(), server: new FakeServer() }).run(['axe'], { gates: {} }, ctx());
    const r = report.results[0];
    expect(r).toMatchObject({
      status: 'failed',
      summary: 'axe: 0 critical, 1 serious (1 route)',
      metrics: { critical: 0, serious: 1, moderate: 1, minor: 0, violations: 2 },
      thresholds: { critical: 0, serious: 0 },
    });
    expect(r?.issues.map((i) => i.severity)).toEqual(['error', 'warning']);
    expect(r?.artifacts).toContain('axe/axe-home.json');

    const relaxed = await createGateRunner({ exec, probe: probe(), server: new FakeServer() }).run(['axe'], { gates: { axe: { failOn: ['critical'] } } }, ctx());
    expect(relaxed.results[0]?.status).toBe('passed');
  });

  it('axe is skipped when @axe-core/playwright is missing', async () => {
    const report = await createGateRunner({ exec: new FakeExecutor(), probe: new FakeProbe({}, ['@playwright/test']), server: new FakeServer() }).run(['axe'], { gates: {} }, ctx());
    expect(report.results[0]).toMatchObject({ status: 'skipped', summary: 'SKIPPED: @axe-core/playwright is not installed in the project' });
  });

  it('visual captures 375/768/1440 screenshots and fails on horizontal overflow', async () => {
    const exec = new FakeExecutor().on(
      'playwright test',
      fakePlaywright(async (out) => {
        for (const width of [375, 768, 1440]) {
          await writeFile(join(out, `home-${width}.png`), 'png');
          await writeFile(
            join(out, `visual-home-${width}.json`),
            JSON.stringify({ route: '/', width, file: `home-${width}.png`, scrollWidth: width === 375 ? 420 : width, overflow: width === 375 }),
          );
        }
      }, [{ title: 'shots', ok: true }]),
    );
    const report = await createGateRunner({ exec, probe: probe(), server: new FakeServer() }).run(['screenshots'], { gates: {} }, ctx());
    const r = report.results[0];
    expect(r).toMatchObject({ gate: 'visual', status: 'failed', metrics: { screenshots: 3, expected: 3, horizontalOverflow: 1 } });
    expect(r?.artifacts).toEqual(expect.arrayContaining(['screenshots/home-375.png', 'screenshots/home-768.png', 'screenshots/home-1440.png']));
    expect(r?.issues[0]?.message).toBe('/ @375px scrolls horizontally (content 420px wide)');
  });

  it('lighthouse runs per route, compares scores with thresholds and is skipped when not installed', async () => {
    const lhr = (perf: number) =>
      JSON.stringify({
        categories: {
          performance: { score: perf, auditRefs: [{ id: 'lcp', weight: 25 }] },
          accessibility: { score: 0.98 },
          seo: { score: 1 },
          'best-practices': { score: 0.96 },
        },
        audits: { lcp: { title: 'Largest Contentful Paint', score: 0.5, displayValue: '3.9 s' } },
      });
    let perf = 0.95;
    const exec = new FakeExecutor().on('/bin/lighthouse', async (cmd) => {
      expect(cmd.args[0]).toBe('http://127.0.0.1:3100/');
      await writeFile(argValue(cmd.args, '--output-path') as string, lhr(perf));
      return { exitCode: 0 };
    });
    const ok = await createGateRunner({ exec, probe: probe(), server: new FakeServer() }).run(['lighthouse'], { gates: {} }, ctx());
    expect(ok.results[0]).toMatchObject({
      status: 'passed',
      summary: 'lighthouse: performance 95, accessibility 98, seo 100, best-practices 96',
      metrics: { performance: 95, accessibility: 98, seo: 100, 'best-practices': 96 },
      thresholds: { performance: 90, accessibility: 95, seo: 95 },
      artifacts: ['lighthouse/home.json'],
    });

    perf = 0.72;
    const bad = await createGateRunner({ exec, probe: probe(), server: new FakeServer() }).run(['lighthouse'], { gates: {} }, ctx());
    expect(bad.results[0]).toMatchObject({ status: 'failed', summary: 'threshold not met: performance 72 < 90' });
    expect(bad.results[0]?.issues[0]?.message).toBe('performance 72 < 90 on /; fix: Largest Contentful Paint (3.9 s)');

    const missing = await createGateRunner({ exec, probe: new FakeProbe(), server: new FakeServer() }).run(['lighthouse'], { gates: {} }, ctx());
    expect(missing.results[0]?.status).toBe('skipped');
    // Fail closed: a missing lighthouse blocks unless gates.yaml explicitly allows skipping it.
    expect(missing.passed).toBe(false);
    const optional = await createGateRunner({ exec, probe: new FakeProbe(), server: new FakeServer() }).run(
      ['lighthouse'],
      { gates: { lighthouse: { allowSkip: true } } },
      ctx(),
    );
    expect(optional.passed).toBe(true);
  });

  it('lighthouse without Chrome is skipped, a gate-level url bypasses the shared server', async () => {
    const exec = new FakeExecutor().on('lighthouse', () => ({ exitCode: 1, stderr: 'No Chrome installations found.' }));
    const server = new FakeServer();
    const report = await createGateRunner({ exec, probe: probe(), server }).run(
      ['lighthouse'],
      { gates: { lighthouse: { url: 'https://preview.local/' } } },
      ctx(),
    );
    expect(exec.calls[0]?.cmd.args[0]).toBe('https://preview.local/');
    expect(server.starts).toHaveLength(0);
    expect(report.results[0]).toMatchObject({
      status: 'skipped',
      summary: 'SKIPPED: lighthouse found no Chrome installation (install Google Chrome, set CHROME_PATH, or run `pnpm exec playwright install chromium`)',
    });
    // The Playwright Chromium fallback was probed (prints nothing here), and lighthouse was not retried.
    expect(exec.calls.filter((c) => c.cmd.command === '/bin/lighthouse')).toHaveLength(1);
  });

  // Regression: lighthouse is blocking (allowSkip: false) in the landing recipe, and T0 installs only
  // Playwright Chromium. Without a system Chrome the gate must fall back to that Chromium, not skip.
  it("lighthouse without system Chrome retries with the project's Playwright Chromium", async () => {
    const chromium = join(dir, 'pw-cache', 'chromium-1194', 'chrome');
    await writeFiles(dir, { 'pw-cache/chromium-1194/chrome': '' });
    const exec = new FakeExecutor()
      .on('--input-type=module', (cmd, opts) => {
        expect(cmd.command).toBe(process.execPath);
        expect(opts.cwd).toBe(dir);
        return { exitCode: 0, stdout: `${chromium}\n` };
      })
      .on('/bin/lighthouse', async (cmd, opts) => {
        if (opts.env?.CHROME_PATH !== chromium) return { exitCode: 1, stderr: 'Runtime error encountered: No Chrome installations found.' };
        await writeFile(
          argValue(cmd.args, '--output-path') as string,
          JSON.stringify({ categories: { performance: { score: 0.93 }, accessibility: { score: 0.97 }, seo: { score: 1 } } }),
        );
        return { exitCode: 0 };
      });
    const routes = { gates: { lighthouse: { routes: ['/', '/pricing'] } } };
    const report = await createGateRunner({ exec, probe: probe(), server: new FakeServer() }).run(['lighthouse'], routes, ctx());
    expect(report.results[0]).toMatchObject({ status: 'passed', metrics: { performance: 93, accessibility: 97, seo: 100 } });
    // Route 1: plain run, probe, retry with CHROME_PATH. Route 2 reuses CHROME_PATH directly.
    const lh = exec.calls.filter((c) => c.cmd.command === '/bin/lighthouse');
    expect(lh.map((c) => c.opts.env?.CHROME_PATH)).toEqual([undefined, chromium, chromium]);
    expect(exec.calls.filter((c) => c.cmd.command === process.execPath)).toHaveLength(1);

    // Chromium reported but not on disk: no retry, blocking skip with the install hint.
    const missing = new FakeExecutor()
      .on('--input-type=module', () => ({ exitCode: 0, stdout: join(dir, 'nope', 'chrome') }))
      .on('/bin/lighthouse', () => ({ exitCode: 1, stderr: 'No Chrome installations found.' }));
    const skippedReport = await createGateRunner({ exec: missing, probe: probe(), server: new FakeServer() }).run(
      ['lighthouse'],
      { gates: { lighthouse: { allowSkip: false } } },
      ctx(),
    );
    expect(skippedReport.results[0]?.status).toBe('skipped');
    expect(skippedReport.passed).toBe(false);
    expect(missing.argvs().filter((a) => a.startsWith('/bin/lighthouse'))).toHaveLength(1);
  });
});
