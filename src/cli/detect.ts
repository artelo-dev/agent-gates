/**
 * Which gates make sense for a project, decided from files on disk. Used when there is no
 * agent-gates.yaml (auto mode) and by `agent-gates init` to write one.
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { GateConfig, GateId } from '../contracts.js';
import { FsToolProbe } from '../exec/probe.js';
import { ESLINT_CONFIG_FILES, TSCONFIG_FILES, detectProject, firstExisting, isPlaceholderTestScript } from '../project.js';
import type { FullGatesConfig, ProjectInfo, ToolProbe } from '../types.js';

export const CONFIG_FILES = ['agent-gates.yaml', 'agent-gates.yml', '.agent-gates.yaml'] as const;

/** Frameworks whose `start` script serves a built site the browser gates can hit. */
const WEB_FRAMEWORKS = ['next', 'nuxt', 'astro', '@remix-run/serve', '@sveltejs/kit', 'gatsby', 'vite'] as const;

export interface GateDecision {
  gate: GateId;
  enabled: boolean;
  /** Why it is on or off, shown to the user. */
  reason: string;
  /** Browser gates: on only when explicitly configured (init) because they need a server and Chromium. */
  browser?: boolean;
}

export interface Detection {
  project: ProjectInfo;
  decisions: GateDecision[];
  /** A web framework with a `start` script was found. */
  web?: { framework: string; hasPlaywright: boolean };
}

async function readPackageJson(cwd: string): Promise<Record<string, unknown> | undefined> {
  try {
    return JSON.parse(await readFile(join(cwd, 'package.json'), 'utf8')) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

function dependencyNames(pkg: Record<string, unknown> | undefined): Set<string> {
  const names = new Set<string>();
  for (const key of ['dependencies', 'devDependencies']) {
    const deps = pkg?.[key];
    if (deps && typeof deps === 'object') for (const name of Object.keys(deps)) names.add(name);
  }
  return names;
}

export async function detectGates(cwd: string, probe: ToolProbe = new FsToolProbe()): Promise<Detection> {
  const project = await detectProject(cwd);
  const pkg = await readPackageJson(cwd);
  const deps = dependencyNames(pkg);
  const decisions: GateDecision[] = [];

  const tsconfig = await firstExisting(cwd, TSCONFIG_FILES);
  decisions.push(
    tsconfig
      ? { gate: 'tsc', enabled: true, reason: `${tsconfig} found` }
      : { gate: 'tsc', enabled: false, reason: 'no tsconfig.json' },
  );

  const eslintConfig = await firstExisting(cwd, ESLINT_CONFIG_FILES);
  const eslintInPkg = pkg !== undefined && 'eslintConfig' in pkg;
  decisions.push(
    eslintConfig || eslintInPkg
      ? { gate: 'eslint', enabled: true, reason: `${eslintConfig ?? 'package.json eslintConfig'} found` }
      : { gate: 'eslint', enabled: false, reason: 'no eslint config' },
  );

  decisions.push({ gate: 'content-lint', enabled: true, reason: 'built in: lorem ipsum, TODO, example.com, empty links, {PLACEHOLDERS}' });

  decisions.push(
    project.scripts.build
      ? { gate: 'build', enabled: true, reason: `"build" script: ${project.scripts.build}` }
      : { gate: 'build', enabled: false, reason: 'no "build" script' },
  );

  decisions.push(
    !isPlaceholderTestScript(project.scripts.test)
      ? { gate: 'tests', enabled: true, reason: `"test" script: ${project.scripts.test}` }
      : { gate: 'tests', enabled: false, reason: 'no "test" script' },
  );

  const framework = WEB_FRAMEWORKS.find((name) => deps.has(name));
  let web: Detection['web'];
  if (framework && project.scripts.start) {
    const has = async (name: string) => deps.has(name) || (await probe.hasModule(name, cwd));
    const hasPlaywright = await has('@playwright/test');
    const hasAxe = hasPlaywright && (await has('@axe-core/playwright'));
    web = { framework, hasPlaywright };
    const ok = `${framework} app with a "start" script`;
    const needPlaywright = 'needs @playwright/test (npm i -D @playwright/test && npx playwright install chromium)';
    decisions.push({
      gate: 'axe',
      enabled: hasAxe,
      browser: true,
      reason: hasAxe ? ok : hasPlaywright ? 'needs @axe-core/playwright (npm i -D @axe-core/playwright)' : needPlaywright,
    });
    decisions.push({ gate: 'visual', enabled: hasPlaywright, browser: true, reason: hasPlaywright ? ok : needPlaywright });
    decisions.push({ gate: 'lighthouse', enabled: false, browser: true, reason: 'off by default: slow; needs the lighthouse package and Chrome' });
  } else {
    const why = framework ? `${framework} found but no "start" script to serve the build` : 'no web framework with a "start" script';
    for (const gate of ['axe', 'visual', 'lighthouse'] as const) decisions.push({ gate, enabled: false, browser: true, reason: why });
  }
  decisions.push({ gate: 'playwright', enabled: false, browser: true, reason: 'smoke test is generated from a spec: pass --spec <file>' });

  const detection: Detection = { project, decisions };
  if (web) detection.web = web;
  return detection;
}

/**
 * Auto mode (no agent-gates.yaml): only the static gates that apply. Browser gates stay off until
 * the user runs `init`, so a first run never fails on a missing browser. Detected gates are
 * fail-closed: if the tool turns out to be missing, the gate fails instead of passing silently.
 */
export function autoConfig(detection: Detection): FullGatesConfig {
  const gates: Partial<Record<GateId, GateConfig>> = {};
  for (const d of detection.decisions) {
    if (d.enabled && !d.browser) gates[d.gate] = { required: true, allowSkip: false };
  }
  return { gates };
}
