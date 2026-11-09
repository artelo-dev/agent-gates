/**
 * agent-gates — hard quality gates for coding agents: tsc, eslint, build, tests, content-lint,
 * playwright smoke, axe, visual and lighthouse runners producing one `GateReport`.
 *
 * Library use:
 *   const config = await loadGatesConfig("gates.yaml");
 *   const report = await createGateRunner().run([], config, { runId, cwd, artifactsDir });
 */
import type { GateId } from './contracts.js';
import { BUILTIN_GATE_IDS } from './ids.js';

/** Gate ids this package provides runners for. */
export const SUPPORTED_GATES: readonly GateId[] = BUILTIN_GATE_IDS;

export type * from './contracts.js';
export * from './ids.js';
export * from './config.js';
export * from './thresholds.js';
export * from './report.js';
export * from './runner.js';
export type * from './types.js';
export { SpawnCommandExecutor, splitCommand, commandFromString, formatCommand, outputTail } from './exec/command.js';
export { FsToolProbe } from './exec/probe.js';
export { buildGateEnv, isDeniedGateEnv, isValidEnvName, BASE_GATE_ENV } from './exec/env.js';
export type { GateEnvOptions } from './exec/env.js';
export { ProcessServerLauncher, waitForUrl } from './exec/server.js';
export { detectProject, findUp } from './project.js';
export { skipped, errored, SKIPPED_PREFIX } from './gates/outcome.js';
export { parseTscOutput, parseEslintJson, tscGate, eslintGate, buildGate, testsGate, customCommandGate } from './gates/command-gates.js';
export {
  lintContent,
  lintText,
  buildRules,
  DEFAULT_EXCLUDES,
  IGNORED_DIRS,
  CODE_EXTENSIONS,
  CONTENT_EXTENSIONS,
} from './gates/content-lint/lint.js';
export type { ContentFinding, ContentLintOptions, ContentLintResult } from './gates/content-lint/lint.js';
export { BUILTIN_CONTENT_RULES, customRules } from './gates/content-lint/rules.js';
export type { ContentRule } from './gates/content-lint/rules.js';
export { globToRegExp, GlobSet } from './gates/content-lint/glob.js';
export { contentLintGate } from './gates/content-lint/gate.js';
export {
  buildSmokePlan,
  generateSmokeTest,
  sampleFromPlaceholder,
  generateAxeTest,
  generateVisualTest,
  generatePlaywrightConfig,
  resolveRoutes,
  slugifyRoute,
} from './gates/browser/generate.js';
export type { SmokePlan, SmokePage, SmokeForm, FormField, RouteTarget } from './gates/browser/generate.js';
export { parsePlaywrightReport } from './gates/browser/playwright-report.js';
export type { PlaywrightSummary, PlaywrightFailure } from './gates/browser/playwright-report.js';
export {
  playwrightGate,
  axeGate,
  visualGate,
  lighthouseGate,
  parseLighthouse,
  summarizeAxe,
  ServerUnavailableError,
} from './gates/browser/gates.js';
