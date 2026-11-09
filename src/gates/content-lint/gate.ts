import type { GateIssue } from '../../contracts.js';
import type { GateImplementation } from '../../types.js';
import { resolve } from 'node:path';
import { errored, plural, thresholdOutcome } from '../outcome.js';
import { BaselineError, newFindings, readBaseline } from './baseline.js';
import { lintContent } from './lint.js';
import type { ContentLintOptions } from './lint.js';

const strings = (v: unknown): string[] | undefined =>
  Array.isArray(v) && v.every((x) => typeof x === 'string') ? (v as string[]) : undefined;

export const contentLintGate: GateImplementation = {
  id: 'content-lint',
  async run(rc) {
    const opts: ContentLintOptions = {};
    const include = strings(rc.config.include);
    const exclude = strings(rc.config.exclude);
    const disableRules = strings(rc.config.disableRules);
    if (include) opts.include = include;
    if (exclude) opts.exclude = exclude;
    if (disableRules) opts.disableRules = disableRules;
    if (rc.config.patterns) opts.patterns = rc.config.patterns;
    if (rc.config.replaceDefaultExcludes === true) opts.replaceDefaultExcludes = true;
    if (rc.ctx.signal) opts.signal = rc.ctx.signal;

    const result = await lintContent(rc.ctx.cwd, opts);
    let baselined = 0;
    if (typeof rc.config.baseline === 'string') {
      let baseline;
      try {
        baseline = await readBaseline(resolve(rc.ctx.cwd, rc.config.baseline));
      } catch (err) {
        if (err instanceof BaselineError) return errored(err.message);
        throw err;
      }
      const fresh = newFindings(result.findings, baseline);
      baselined = result.findings.length - fresh.length;
      result.findings = fresh;
    }
    const issues: GateIssue[] = result.findings.map((f) => ({
      severity: 'error',
      message: `${f.message}: ${JSON.stringify(f.match)} — ${f.excerpt}`,
      file: f.file,
      line: f.line,
      column: f.column,
      rule: f.rule,
    }));
    if (result.truncated) issues.push({ severity: 'warning', message: 'file limit reached; not every file was scanned' });
    const errors = result.findings.length;
    const metrics: Record<string, number> = { errors, files: result.filesScanned };
    if (baselined > 0) metrics.baselined = baselined;
    const outcome = thresholdOutcome(
      rc,
      metrics,
      issues,
      `no forbidden content in ${plural(result.filesScanned, 'file')}${baselined > 0 ? ` (${baselined} known, in baseline)` : ''}`,
    );
    if (outcome.status === 'failed') {
      const byRule = new Map<string, number>();
      for (const f of result.findings) byRule.set(f.rule, (byRule.get(f.rule) ?? 0) + 1);
      outcome.summary = `${plural(errors, 'content problem')} (${[...byRule].map(([r, n]) => `${r}: ${n}`).join(', ')})`;
    }
    return outcome;
  },
};
