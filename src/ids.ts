import type { GateId, KnownGateId } from './contracts.js';

/** Gate ids with a built-in runner: core's known gates plus `tests` (project test script). */
export const BUILTIN_GATE_IDS = [
  'tsc',
  'eslint',
  'build',
  'tests',
  'content-lint',
  'playwright',
  'axe',
  'visual',
  'lighthouse',
] as const satisfies readonly GateId[];

export type BuiltinGateId = (typeof BUILTIN_GATE_IDS)[number];

/** Compile-time check that every core KnownGateId has a built-in runner. */
type _AllKnownCovered = KnownGateId extends BuiltinGateId ? true : never;
export const ALL_KNOWN_GATES_COVERED: _AllKnownCovered = true;

/** Friendly names accepted in gates.yaml / CLI and the canonical id they map to. */
export const GATE_ALIASES: Readonly<Record<string, BuiltinGateId>> = {
  typecheck: 'tsc',
  types: 'tsc',
  lint: 'eslint',
  test: 'tests',
  smoke: 'playwright',
  'playwright-smoke': 'playwright',
  screenshots: 'visual',
  a11y: 'axe',
  content: 'content-lint',
};

/**
 * Order gates run in when the caller does not care: cheap static checks first, build before
 * anything that needs a running app.
 */
export const DEFAULT_GATE_ORDER: readonly BuiltinGateId[] = BUILTIN_GATE_IDS;

export function normalizeGateId(id: string): GateId {
  const trimmed = id.trim();
  return GATE_ALIASES[trimmed] ?? trimmed;
}

export function isBuiltinGate(id: string): id is BuiltinGateId {
  return (BUILTIN_GATE_IDS as readonly string[]).includes(id);
}
