import { describe, expect, it } from 'vitest';
import { describeViolation, evaluateThresholds, thresholdDirection } from '../src/index.js';

describe('threshold evaluation', () => {
  it('treats scores as floors and counts as ceilings', () => {
    expect(thresholdDirection('performance')).toBe('min');
    expect(thresholdDirection('seo')).toBe('min');
    expect(thresholdDirection('errors')).toBe('max');
    expect(thresholdDirection('serious')).toBe('max');
  });

  it('passes at exactly the threshold', () => {
    expect(evaluateThresholds({ performance: 90, errors: 0 }, { performance: 90, errors: 0 }).passed).toBe(true);
  });

  it('fails Lighthouse scores below the floor and counts above the ceiling', () => {
    const res = evaluateThresholds(
      { performance: 89, accessibility: 100, seo: 94, critical: 0, serious: 2 },
      { performance: 90, accessibility: 95, seo: 95, critical: 0, serious: 0 },
    );
    expect(res.passed).toBe(false);
    expect(res.violations.map(describeViolation)).toEqual(['performance 89 < 90', 'seo 94 < 95', 'serious 2 > 0']);
  });

  it('counts unmeasured metrics as violations unless told to ignore them', () => {
    expect(evaluateThresholds({}, { seo: 95 }).violations[0]).toMatchObject({ metric: 'seo', actual: undefined });
    expect(describeViolation({ metric: 'seo', direction: 'min', actual: undefined, threshold: 95 })).toMatch(/not measured/);
    expect(evaluateThresholds({}, { seo: 95 }, { ignoreMissing: true }).passed).toBe(true);
  });

  it('allows explicit direction overrides', () => {
    expect(evaluateThresholds({ custom: 5 }, { custom: 3 }, { directions: { custom: 'min' } }).passed).toBe(true);
  });
});
