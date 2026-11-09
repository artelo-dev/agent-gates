import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_GATES_CONFIG,
  GatesConfigError,
  enabledGates,
  loadGatesConfig,
  normalizeGateId,
  parseGatesYaml,
  resolveGateConfig,
  stringifyGatesConfig,
} from '../src/index.js';

const preset = fileURLToPath(new URL('../presets/landing.gates.yaml', import.meta.url));

describe('gates.yaml config', () => {
  it('ships a landing preset identical to DEFAULT_GATES_CONFIG', async () => {
    expect(await loadGatesConfig(preset)).toEqual(DEFAULT_GATES_CONFIG);
  });

  // Regression: lighthouse / axe / visual / tests used to inherit allowSkip: true, so a missing tool or
  // browser was reported "skipped" and the landing run still passed its gates.
  it('makes every landing gate blocking', () => {
    for (const [id, gate] of Object.entries(DEFAULT_GATES_CONFIG.gates)) {
      expect(resolveGateConfig(DEFAULT_GATES_CONFIG, id).allowSkip, id).toBe(false);
      expect(gate?.required, id).toBe(true);
    }
  });

  // Regression: allowSkip defaulted to true when gates.yaml did not set it, so with an empty or partial
  // config a missing tool or browser ("skipped") counted as passed.
  it('defaults allowSkip to false for gates gates.yaml does not mention, built-in or custom', () => {
    const cfg = parseGatesYaml(`
gates:
  lighthouse: {}
  links: { command: "node check-links.mjs" }
  optional: { command: "true", allowSkip: true }
`);
    expect(resolveGateConfig({ gates: {} }, 'lighthouse').allowSkip).toBe(false);
    expect(resolveGateConfig(cfg, 'lighthouse').allowSkip).toBe(false);
    expect(resolveGateConfig(cfg, 'links').allowSkip).toBe(false);
    expect(resolveGateConfig(cfg, 'optional').allowSkip).toBe(true);
  });

  it('round-trips through stringify', () => {
    expect(parseGatesYaml(stringifyGatesConfig(DEFAULT_GATES_CONFIG))).toEqual(DEFAULT_GATES_CONFIG);
  });

  it('falls back to defaults when the file is missing', async () => {
    expect(await loadGatesConfig('/nonexistent/artelo/gates.yaml')).toEqual(DEFAULT_GATES_CONFIG);
  });

  it('applies documented default thresholds', () => {
    const empty = { gates: {} };
    expect(resolveGateConfig(empty, 'lighthouse').thresholds).toEqual({ performance: 90, accessibility: 95, seo: 95 });
    expect(resolveGateConfig(empty, 'axe').thresholds).toEqual({ critical: 0, serious: 0 });
    expect(resolveGateConfig(empty, 'tsc').thresholds).toEqual({ errors: 0 });
    expect(resolveGateConfig(empty, 'visual').viewports).toEqual([375, 768, 1440]);
    const tsc = resolveGateConfig(empty, 'tsc');
    expect(tsc).toMatchObject({ enabled: true, required: true, allowSkip: false });
    expect(tsc.timeoutMs).toBeGreaterThan(0);
  });

  it('merges user thresholds over defaults and derives axe thresholds from failOn', () => {
    const cfg = parseGatesYaml(`
gates:
  lighthouse: { thresholds: { performance: 80 } }
  axe: { failOn: [critical] }
  typecheck: { command: "pnpm exec tsc --noEmit", timeoutMs: 1000 }
`);
    expect(resolveGateConfig(cfg, 'lighthouse').thresholds).toEqual({ performance: 80, accessibility: 95, seo: 95 });
    expect(resolveGateConfig(cfg, 'axe').thresholds).toEqual({ critical: 0 });
    expect(resolveGateConfig(cfg, 'tsc')).toMatchObject({ command: 'pnpm exec tsc --noEmit', timeoutMs: 1000 });
  });

  it('normalises aliases and supports true/false shorthands', () => {
    const cfg = parseGatesYaml('gates:\n  typecheck: true\n  screenshots: false\n  smoke: {}\n');
    expect(Object.keys(cfg.gates)).toEqual(['tsc', 'visual', 'playwright']);
    expect(enabledGates(cfg)).toEqual(['tsc', 'playwright']);
    expect(normalizeGateId('lint')).toBe('eslint');
    expect(normalizeGateId('custom-gate')).toBe('custom-gate');
  });

  it('reports every validation problem at once', () => {
    let error: unknown;
    try {
      parseGatesYaml(`
server: { url: "not a url", port: -1 }
gates:
  tsc: { required: "yes", thresholds: { errors: "zero" } }
  content-lint: { patterns: ["("] }
  axe: { failOn: [catastrophic] }
  visual: { viewports: [0] }
  build: 42
`);
    } catch (err) {
      error = err;
    }
    expect(error).toBeInstanceOf(GatesConfigError);
    const problems = (error as GatesConfigError).problems;
    expect(problems).toHaveLength(8);
    expect(problems.join('\n')).toMatch(/gates\.tsc\.required/);
    expect(problems.join('\n')).toMatch(/invalid regex/);
    expect(problems.join('\n')).toMatch(/catastrophic/);
    expect(problems.join('\n')).toMatch(/server\.url/);
  });

  it('rejects YAML syntax errors with a GatesConfigError', () => {
    expect(() => parseGatesYaml('gates: [unclosed')).toThrow(GatesConfigError);
  });
});
