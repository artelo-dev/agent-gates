/**
 * Threshold evaluation. A threshold is either a floor (score must be >= value, e.g. Lighthouse
 * `performance: 90`) or a ceiling (count must be <= value, e.g. `errors: 0`, axe `serious: 0`).
 */
export type ThresholdDirection = 'min' | 'max';

/** Metric names that are scores (higher is better). Everything else is a count (lower is better). */
export const MIN_METRICS: ReadonlySet<string> = new Set([
  'performance',
  'accessibility',
  'seo',
  'best-practices',
  'bestPractices',
  'pwa',
  'score',
  'coverage',
]);

export function thresholdDirection(metric: string): ThresholdDirection {
  return MIN_METRICS.has(metric) || metric.startsWith('min') ? 'min' : 'max';
}

export interface ThresholdViolation {
  metric: string;
  direction: ThresholdDirection;
  /** `undefined` when the metric was not measured at all. */
  actual: number | undefined;
  threshold: number;
}

export interface ThresholdEvaluation {
  passed: boolean;
  violations: ThresholdViolation[];
}

/**
 * Compare measured metrics against thresholds. A threshold whose metric was not measured is a
 * violation unless `ignoreMissing` is set (e.g. a Lighthouse category the run did not collect).
 */
export function evaluateThresholds(
  metrics: Readonly<Record<string, number>>,
  thresholds: Readonly<Record<string, number>>,
  opts: { ignoreMissing?: boolean; directions?: Readonly<Record<string, ThresholdDirection>> } = {},
): ThresholdEvaluation {
  const violations: ThresholdViolation[] = [];
  for (const [metric, threshold] of Object.entries(thresholds)) {
    const direction = opts.directions?.[metric] ?? thresholdDirection(metric);
    const actual = metrics[metric];
    if (actual === undefined || Number.isNaN(actual)) {
      if (!opts.ignoreMissing) violations.push({ metric, direction, actual: undefined, threshold });
      continue;
    }
    const ok = direction === 'min' ? actual >= threshold : actual <= threshold;
    if (!ok) violations.push({ metric, direction, actual, threshold });
  }
  return { passed: violations.length === 0, violations };
}

export function describeViolation(v: ThresholdViolation): string {
  if (v.actual === undefined) return `${v.metric}: not measured (threshold ${v.threshold})`;
  return v.direction === 'min'
    ? `${v.metric} ${v.actual} < ${v.threshold}`
    : `${v.metric} ${v.actual} > ${v.threshold}`;
}
