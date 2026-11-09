/**
 * Public contracts of agent-gates: gate ids, results, the aggregated report, gates.yaml shape and
 * the optional project spec the browser smoke gate is generated from.
 */

/** ISO-8601 timestamp, e.g. `new Date().toISOString()`. */
export type IsoDate = string;

/** Open string union: autocomplete for the known literals, custom ids still accepted. */
export type OpenUnion<T extends string> = T | (string & {});

// ---------------------------------------------------------------------------
// Gates
// ---------------------------------------------------------------------------

export type KnownGateId =
  | 'tsc'
  | 'eslint'
  | 'build'
  | 'tests'
  | 'playwright'
  | 'content-lint'
  | 'lighthouse'
  | 'axe'
  | 'visual';

export type GateId = OpenUnion<KnownGateId>;

export type GateStatus = 'passed' | 'failed' | 'skipped' | 'error';

export interface GateIssue {
  severity: 'error' | 'warning' | 'info';
  message: string;
  file?: string;
  line?: number;
  column?: number;
  rule?: string;
}

export interface GateResult {
  gate: GateId;
  status: GateStatus;
  /** One-line human summary, also what an agent reads on failure. */
  summary: string;
  durationMs: number;
  issues: GateIssue[];
  /** Measured values, e.g. `{ performance: 93, accessibility: 97 }`. */
  metrics?: Record<string, number>;
  /** Thresholds the metrics were compared against (from gates.yaml). */
  thresholds?: Record<string, number>;
  /** Paths of produced artefacts (reports, screenshots) relative to `artifactsDir`. */
  artifacts?: string[];
  /** Tail of the raw command output (truncated). */
  output?: string;
  /** Set on aggregation: this result is why the report failed (incl. a skipped gate with allowSkip: false). */
  blocking?: boolean;
}

export interface GateReport {
  runId: string;
  taskId?: string;
  /** True iff every required gate passed (or was skipped where skipping is allowed). */
  passed: boolean;
  startedAt: IsoDate;
  finishedAt: IsoDate;
  results: GateResult[];
}

/** One entry under `gates:` in gates.yaml. */
export interface GateConfig {
  enabled?: boolean;
  /** Failing a non-required gate is reported but does not fail the report. Default true. */
  required?: boolean;
  /** Override command (e.g. `pnpm exec tsc --noEmit`). */
  command?: string;
  timeoutMs?: number;
  /** Numeric thresholds, e.g. `{ performance: 90, accessibility: 95, seo: 95 }` or `{ errors: 0 }`. */
  thresholds?: Record<string, number>;
  /** Forbidden patterns for content-lint (regex sources). */
  patterns?: string[];
  /** Viewport widths for the visual gate. */
  viewports?: number[];
  /** Severities that fail the gate (axe), e.g. `['critical', 'serious']`. */
  failOn?: string[];
  [extra: string]: unknown;
}

/** Shape of the `gates:` block of gates.yaml. */
export interface GatesConfig {
  gates: Partial<Record<GateId, GateConfig>>;
}

/** Runtime context passed to gate runners. */
export interface GateContext {
  runId: string;
  taskId?: string;
  /** Project directory to check. */
  cwd: string;
  /** Where reports and screenshots go. */
  artifactsDir: string;
  /** Optional project spec; the playwright smoke gate is generated from it. */
  spec?: Spec;
  signal?: AbortSignal;
}

export interface GateRunner {
  run(gates: GateId[], config: GatesConfig, ctx: GateContext): Promise<GateReport>;
}

// ---------------------------------------------------------------------------
// Project spec (optional; only the playwright smoke gate reads it)
// ---------------------------------------------------------------------------

/** A bare string, or an object that marks a criterion manual / names the gate that checks it. */
export type AcceptanceCriterion = string | { text: string; manual?: boolean; check?: string };

export interface SpecSection {
  id: string;
  purpose?: string;
  /** Section copy/data. A section with `content.fields` is treated as a form by the smoke test. */
  content?: Record<string, unknown>;
  acceptance?: AcceptanceCriterion[];
}

export interface SpecPage {
  id: string;
  route: string;
  title?: string;
  sections: SpecSection[];
}

/**
 * The parts of a project spec the smoke gate uses: pages, their routes and sections.
 * Extra keys are allowed so a full spec file can be passed as is.
 */
export interface Spec {
  pages: SpecPage[];
  [extra: string]: unknown;
}
