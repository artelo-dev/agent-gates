/**
 * Browser gates. All need the preview server (shared, started lazily by the runner) and a
 * successful build. Optional tooling is probed first; a missing tool yields `skipped` with the
 * reason, never a silent `passed`.
 */
import { mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import type { GateIssue } from '../../contracts.js';
import { formatCommand, outputTail } from '../../exec/command.js';
import { toolCommand } from '../../project.js';
import type { ExecResult, GateImplementation, GateOutcome, GateRunContext, ServerHandle } from '../../types.js';
import { abnormalExit, errored, plural, runGateCommand, skipped, thresholdOutcome } from '../outcome.js';
import {
  buildSmokePlan,
  generateAxeTest,
  generatePlaywrightConfig,
  generateSmokeTest,
  generateVisualTest,
  resolveRoutes,
} from './generate.js';
import type { RouteTarget } from './generate.js';
import { parsePlaywrightReport } from './playwright-report.js';
import type { PlaywrightSummary } from './playwright-report.js';

export class ServerUnavailableError extends Error {
  override name = 'ServerUnavailableError';
}

const BROWSERS_MISSING = /Executable doesn't exist|npx playwright install|browserType\.launch/i;
const CHROME_MISSING = /No Chrome installations found|CHROME_PATH|Unable to connect to Chrome/i;

function configuredRoutes(rc: GateRunContext): string[] | undefined {
  const r = rc.config.routes;
  return Array.isArray(r) && r.every((x) => typeof x === 'string') ? (r as string[]) : undefined;
}

function routesFor(rc: GateRunContext): RouteTarget[] {
  return resolveRoutes(rc.ctx.spec, configuredRoutes(rc));
}

const rel = (rc: GateRunContext, path: string) => relative(rc.ctx.artifactsDir, path).split('\\').join('/');

/** Start (or reuse) the preview server, or a gate-level `url` override. */
async function baseUrl(rc: GateRunContext): Promise<string | GateOutcome> {
  if (typeof rc.config.url === 'string' && rc.config.url) return rc.config.url.replace(/\/+$/, '');
  let server: ServerHandle;
  try {
    server = await rc.server();
  } catch (err) {
    if (err instanceof ServerUnavailableError) return skipped(err.message);
    return errored(`preview server: ${(err as Error).message}`);
  }
  return server.url;
}

interface SuiteRun {
  res: ExecResult;
  summary?: PlaywrightSummary;
  outDir: string;
  artifacts: string[];
  /** Set when the run could not be evaluated (skip/error). */
  outcome?: GateOutcome;
}

/** Write a generated suite + config into the scratch dir and run it with the project's Playwright. */
async function runPlaywrightSuite(rc: GateRunContext, kind: string, source: (outDir: string) => string, url: string): Promise<SuiteRun> {
  const workDir = join(await rc.workDir(), kind);
  const outDir = join(rc.ctx.artifactsDir, kind);
  await mkdir(workDir, { recursive: true });
  await mkdir(outDir, { recursive: true });
  const testFile = `agent-gates-${kind}.spec.mjs`;
  const jsonReport = join(outDir, 'playwright-report.json');
  const spec = source(outDir);
  await writeFile(join(workDir, testFile), spec);
  await writeFile(join(outDir, testFile), spec);
  const configPath = join(workDir, 'playwright.config.mjs');
  await writeFile(
    configPath,
    generatePlaywrightConfig({ testFile, baseURL: url, jsonReport, outputDir: join(outDir, 'test-results') }),
  );
  const cmd = await toolCommand(rc.probe, rc.ctx.cwd, 'playwright', ['test', '--config', configPath]);
  const res = await runGateCommand(rc, cmd, { PLAYWRIGHT_JSON_OUTPUT_NAME: jsonReport });
  const artifacts = [rel(rc, join(outDir, testFile))];
  const run: SuiteRun = { res, outDir, artifacts };
  const abnormal = abnormalExit(cmd, res);
  if (abnormal) return { ...run, outcome: abnormal };
  const output = `${res.stdout}\n${res.stderr}`;
  let reportText: string | undefined;
  try {
    reportText = await readFile(jsonReport, 'utf8');
  } catch {
    reportText = undefined;
  }
  if (reportText === undefined) {
    if (BROWSERS_MISSING.test(output)) {
      return { ...run, outcome: skipped('Playwright browsers not installed (run `npx playwright install chromium`)', { output: outputTail(res) }) };
    }
    return { ...run, outcome: errored(`\`${formatCommand(cmd)}\` produced no report (exit ${res.exitCode})`, { output: outputTail(res) }) };
  }
  let summary: PlaywrightSummary;
  try {
    summary = parsePlaywrightReport(reportText);
  } catch (err) {
    return { ...run, outcome: errored(`unreadable Playwright report: ${(err as Error).message}`, { output: outputTail(res) }) };
  }
  artifacts.push(rel(rc, jsonReport));
  if (summary.total > 0 && summary.failed === summary.total && summary.failures.every((f) => BROWSERS_MISSING.test(f.message))) {
    return { ...run, summary, outcome: skipped('Playwright browsers not installed (run `npx playwright install chromium`)') };
  }
  return { ...run, summary };
}

async function readJsonFiles<T>(dir: string, prefix: string): Promise<T[]> {
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return [];
  }
  const out: T[] = [];
  for (const name of names.filter((n) => n.startsWith(prefix) && n.endsWith('.json')).sort()) {
    try {
      out.push(JSON.parse(await readFile(join(dir, name), 'utf8')) as T);
    } catch {
      /* partial write from a crashed test: ignore */
    }
  }
  return out;
}

async function requirePlaywright(rc: GateRunContext): Promise<GateOutcome | undefined> {
  if (!(await rc.probe.hasModule('@playwright/test', rc.ctx.cwd))) {
    return skipped('@playwright/test is not installed in the project');
  }
  return undefined;
}

function failureIssues(summary: PlaywrightSummary): GateIssue[] {
  return summary.failures.map((f) => {
    const issue: GateIssue = { severity: 'error', message: `${f.title}: ${f.message}`, rule: 'playwright' };
    if (f.file) issue.file = f.file;
    if (f.line !== undefined) issue.line = f.line;
    return issue;
  });
}

// ---------------------------------------------------------------------------
// playwright smoke
// ---------------------------------------------------------------------------

export const playwrightGate: GateImplementation = {
  id: 'playwright',
  browser: true,
  async run(rc) {
    if (!rc.ctx.spec) return skipped('no spec in gate context; the smoke test is generated from the spec');
    const plan = buildSmokePlan(rc.ctx.spec);
    if (plan.pages.length === 0) return skipped('spec has no static pages to smoke-test');
    const missingTool = await requirePlaywright(rc);
    if (missingTool) return missingTool;
    const url = await baseUrl(rc);
    if (typeof url !== 'string') return url;
    const mock = typeof rc.config.mockPathPrefix === 'string' ? rc.config.mockPathPrefix : '/api/';
    const run = await runPlaywrightSuite(rc, 'smoke', (outDir) => generateSmokeTest(plan, { outDir, mockPathPrefix: mock }), url);
    if (run.outcome) return { ...run.outcome, artifacts: run.artifacts };
    const summary = run.summary as PlaywrightSummary;
    const sections = await readJsonFiles<{ route: string; expected: string[]; missing: string[] }>(run.outDir, 'sections-');
    const expected = plan.pages.reduce((n, p) => n + p.sections.length, 0);
    const missing = sections.reduce((n, s) => n + s.missing.length, 0);
    const issues = failureIssues(summary);
    for (const s of sections) {
      for (const id of s.missing) issues.push({ severity: 'error', message: `[data-section="${id}"] missing on ${s.route}`, rule: 'data-section' });
    }
    const metrics = {
      failures: summary.failed,
      tests: summary.total,
      sectionsExpected: expected,
      sectionsMissing: missing,
      forms: plan.forms.length,
    };
    const outcome = thresholdOutcome(
      rc,
      metrics,
      issues,
      `${plural(summary.passed, 'smoke test')} passed (${expected} sections, ${plural(plan.forms.length, 'form')})`,
      { artifacts: run.artifacts },
    );
    if (outcome.status === 'failed') {
      outcome.summary = `${plural(summary.failed, 'smoke test')} failed${missing ? `; ${plural(missing, 'section')} missing` : ''}`;
      outcome.output = outputTail(run.res);
    }
    return outcome;
  },
};

// ---------------------------------------------------------------------------
// axe
// ---------------------------------------------------------------------------

interface AxeViolation {
  id: string;
  impact: string;
  help: string;
  helpUrl?: string;
  count: number;
  targets?: string[];
}

export function summarizeAxe(files: ReadonlyArray<{ route: string; violations: AxeViolation[] }>, failOn: readonly string[]) {
  const metrics: Record<string, number> = { critical: 0, serious: 0, moderate: 0, minor: 0, violations: 0 };
  const issues: GateIssue[] = [];
  for (const file of files) {
    for (const v of file.violations) {
      const impact = v.impact in metrics ? v.impact : 'minor';
      metrics[impact] = (metrics[impact] ?? 0) + 1;
      metrics.violations = (metrics.violations ?? 0) + 1;
      issues.push({
        severity: failOn.includes(impact) ? 'error' : 'warning',
        rule: v.id,
        message: `${impact}: ${v.help} (${plural(v.count, 'node')} on ${file.route})${v.targets?.length ? ` e.g. ${v.targets[0]}` : ''}`,
      });
    }
  }
  return { metrics, issues };
}

export const axeGate: GateImplementation = {
  id: 'axe',
  browser: true,
  async run(rc) {
    const missingTool = await requirePlaywright(rc);
    if (missingTool) return missingTool;
    if (!(await rc.probe.hasModule('@axe-core/playwright', rc.ctx.cwd))) {
      return skipped('@axe-core/playwright is not installed in the project');
    }
    const url = await baseUrl(rc);
    if (typeof url !== 'string') return url;
    const routes = routesFor(rc);
    const tags = Array.isArray(rc.config.tags) ? (rc.config.tags as string[]) : undefined;
    const run = await runPlaywrightSuite(rc, 'axe', (outDir) => generateAxeTest(routes, tags ? { outDir, tags } : { outDir }), url);
    if (run.outcome) return { ...run.outcome, artifacts: run.artifacts };
    const summary = run.summary as PlaywrightSummary;
    const files = await readJsonFiles<{ route: string; violations: AxeViolation[] }>(run.outDir, 'axe-');
    const failOn = (rc.config.failOn as string[] | undefined) ?? ['critical', 'serious'];
    const { metrics, issues } = summarizeAxe(files, failOn);
    const artifacts = [...run.artifacts, ...routes.map((r) => rel(rc, join(run.outDir, `axe-${r.id}.json`)))];
    if (files.length < routes.length) {
      return errored(`axe scanned ${files.length}/${routes.length} routes`, {
        issues: [...failureIssues(summary), ...issues],
        metrics,
        artifacts,
        output: outputTail(run.res),
      });
    }
    const outcome = thresholdOutcome(rc, metrics, issues, `axe: ${plural(metrics.violations ?? 0, 'violation')}, none ${failOn.join('/')}`, {
      artifacts,
    });
    if (outcome.status === 'failed') {
      outcome.summary = `axe: ${failOn.map((i) => `${metrics[i] ?? 0} ${i}`).join(', ')} (${plural(routes.length, 'route')})`;
    }
    return outcome;
  },
};

// ---------------------------------------------------------------------------
// visual (screenshots)
// ---------------------------------------------------------------------------

export const visualGate: GateImplementation = {
  id: 'visual',
  browser: true,
  async run(rc) {
    const missingTool = await requirePlaywright(rc);
    if (missingTool) return missingTool;
    const url = await baseUrl(rc);
    if (typeof url !== 'string') return url;
    const routes = routesFor(rc);
    const viewports = rc.config.viewports ?? [375, 768, 1440];
    const run = await runPlaywrightSuite(rc, 'screenshots', (outDir) => generateVisualTest(routes, { outDir, viewports }), url);
    if (run.outcome) return { ...run.outcome, artifacts: run.artifacts };
    const summary = run.summary as PlaywrightSummary;
    const shots = await readJsonFiles<{ route: string; width: number; file: string; overflow: boolean; scrollWidth: number }>(
      run.outDir,
      'visual-',
    );
    const issues = failureIssues(summary);
    for (const s of shots.filter((x) => x.overflow)) {
      issues.push({
        severity: 'error',
        rule: 'horizontal-overflow',
        message: `${s.route} @${s.width}px scrolls horizontally (content ${s.scrollWidth}px wide)`,
      });
    }
    const expected = routes.length * viewports.length;
    const metrics = {
      screenshots: shots.length,
      expected,
      horizontalOverflow: shots.filter((x) => x.overflow).length,
      failures: summary.failed,
    };
    const artifacts = [...run.artifacts, ...shots.map((s) => rel(rc, join(run.outDir, s.file)))];
    if (shots.length < expected) {
      return {
        status: 'failed',
        summary: `captured ${shots.length}/${expected} screenshots`,
        issues,
        metrics,
        thresholds: rc.config.thresholds,
        artifacts,
        output: outputTail(run.res),
      };
    }
    return thresholdOutcome(rc, metrics, issues, `${plural(shots.length, 'screenshot')} at ${viewports.join('/')}px`, { artifacts });
  },
};

// ---------------------------------------------------------------------------
// lighthouse
// ---------------------------------------------------------------------------

const LH_CATEGORIES = ['performance', 'accessibility', 'seo', 'best-practices'] as const;

interface Lhr {
  categories?: Record<string, { score: number | null; auditRefs?: Array<{ id: string; weight: number }> }>;
  audits?: Record<string, { title?: string; score: number | null; displayValue?: string }>;
  runtimeError?: { code?: string; message?: string };
}

/** Category scores (0–100) and the failing audits for one Lighthouse result. */
export function parseLighthouse(json: string): { scores: Record<string, number>; failingAudits: Record<string, string[]>; runtimeError?: string } {
  const lhr = JSON.parse(json) as Lhr;
  const scores: Record<string, number> = {};
  const failingAudits: Record<string, string[]> = {};
  for (const [id, cat] of Object.entries(lhr.categories ?? {})) {
    if (typeof cat.score === 'number') scores[id] = Math.round(cat.score * 100);
    failingAudits[id] = (cat.auditRefs ?? [])
      .filter((ref) => ref.weight > 0)
      .map((ref) => ({ ref, audit: lhr.audits?.[ref.id] }))
      .filter(({ audit }) => audit && typeof audit.score === 'number' && audit.score < 0.9)
      .sort((a, b) => b.ref.weight - a.ref.weight)
      .slice(0, 5)
      .map(({ ref, audit }) => `${audit?.title ?? ref.id}${audit?.displayValue ? ` (${audit.displayValue})` : ''}`);
  }
  const result: { scores: Record<string, number>; failingAudits: Record<string, string[]>; runtimeError?: string } = { scores, failingAudits };
  if (lhr.runtimeError?.code) result.runtimeError = `${lhr.runtimeError.code}: ${lhr.runtimeError.message ?? ''}`.trim();
  return result;
}

const CHROME_MISSING_REASON =
  'lighthouse found no Chrome installation (install Google Chrome, set CHROME_PATH, or run `pnpm exec playwright install chromium`)';

/** Prints the project's Playwright Chromium path; run with the project as cwd so the import resolves there. */
const PLAYWRIGHT_CHROMIUM_SCRIPT = "const { chromium } = await import('@playwright/test'); process.stdout.write(chromium.executablePath());";

/**
 * The project's Playwright Chromium binary, when it is installed. Lighthouse falls back to it when
 * chrome-launcher finds no system Chrome: the landing T0 installs Playwright Chromium, so a fresh
 * machine can still run the (blocking) Lighthouse gate without a separate Chrome install.
 */
async function playwrightChromium(rc: GateRunContext): Promise<string | undefined> {
  if (!(await rc.probe.hasModule('@playwright/test', rc.ctx.cwd))) return undefined;
  const res = await runGateCommand(rc, { command: process.execPath, args: ['--input-type=module', '-e', PLAYWRIGHT_CHROMIUM_SCRIPT] });
  const path = res.exitCode === 0 ? res.stdout.trim() : '';
  if (!path) return undefined;
  try {
    return (await stat(path)).isFile() ? path : undefined;
  } catch {
    return undefined;
  }
}

async function readOptional(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, 'utf8');
  } catch {
    return undefined;
  }
}

export const lighthouseGate: GateImplementation = {
  id: 'lighthouse',
  browser: true,
  async run(rc) {
    const bin = await rc.probe.findBin('lighthouse', rc.ctx.cwd);
    if (!bin) return skipped('lighthouse is not installed (add it as a devDependency or globally)');
    const url = await baseUrl(rc);
    if (typeof url !== 'string') return url;
    const routes = routesFor(rc);
    const outDir = join(rc.ctx.artifactsDir, 'lighthouse');
    await mkdir(outDir, { recursive: true });
    const metrics: Record<string, number> = {};
    const issues: GateIssue[] = [];
    const artifacts: string[] = [];
    const outputs: string[] = [];
    const preset = rc.config.preset === 'desktop' ? ['--preset=desktop'] : [];
    // Set once lighthouse reported no Chrome and Playwright's Chromium was found; reused for later routes.
    let chromeEnv: Record<string, string> | undefined;
    let triedFallback = false;
    for (const route of routes) {
      const file = join(outDir, `${route.id}.json`);
      const cmd = {
        command: bin,
        args: [
          `${url}${route.route}`,
          '--output=json',
          `--output-path=${file}`,
          '--quiet',
          `--only-categories=${LH_CATEGORIES.join(',')}`,
          '--chrome-flags=--headless=new --no-sandbox',
          ...preset,
        ],
      };
      // A report left by an earlier attempt must never be read as this run's result.
      await rm(file, { force: true });
      let res = await runGateCommand(rc, cmd, chromeEnv);
      let abnormal = abnormalExit(cmd, res);
      if (abnormal) return { ...abnormal, metrics, artifacts };
      let text = await readOptional(file);
      if (text === undefined && !triedFallback && CHROME_MISSING.test(`${res.stdout}\n${res.stderr}`)) {
        triedFallback = true;
        const chromium = await playwrightChromium(rc);
        if (chromium) {
          chromeEnv = { CHROME_PATH: chromium };
          res = await runGateCommand(rc, cmd, chromeEnv);
          abnormal = abnormalExit(cmd, res);
          if (abnormal) return { ...abnormal, metrics, artifacts };
          text = await readOptional(file);
        }
      }
      outputs.push(outputTail(res, 1000));
      if (text === undefined) {
        if (CHROME_MISSING.test(`${res.stdout}\n${res.stderr}`)) return skipped(CHROME_MISSING_REASON, { output: outputTail(res) });
        return errored(`lighthouse produced no report for ${route.route} (exit ${res.exitCode})`, { output: outputTail(res), metrics, artifacts });
      }
      artifacts.push(rel(rc, file));
      const parsed = parseLighthouse(text);
      if (parsed.runtimeError) {
        return errored(`lighthouse runtime error on ${route.route}: ${parsed.runtimeError}`, { metrics, artifacts });
      }
      for (const cat of LH_CATEGORIES) {
        const score = parsed.scores[cat];
        if (score === undefined) continue;
        metrics[cat] = Math.min(metrics[cat] ?? 100, score);
        const threshold = rc.config.thresholds[cat];
        if (threshold !== undefined && score < threshold) {
          const audits = parsed.failingAudits[cat] ?? [];
          issues.push({
            severity: 'error',
            rule: `lighthouse:${cat}`,
            message: `${cat} ${score} < ${threshold} on ${route.route}${audits.length ? `; fix: ${audits.join('; ')}` : ''}`,
          });
        }
      }
    }
    const scoreLine = LH_CATEGORIES.filter((c) => metrics[c] !== undefined).map((c) => `${c} ${metrics[c]}`).join(', ');
    const outcome = thresholdOutcome(rc, metrics, issues, `lighthouse: ${scoreLine}`, { artifacts });
    if (outcome.status === 'failed') outcome.output = outputs.join('\n').slice(-4000);
    return outcome;
  },
};
