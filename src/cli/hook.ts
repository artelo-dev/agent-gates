/**
 * `agent-gates hook claude`: a Claude Code Stop hook. When Claude tries to finish, run the gates;
 * if they fail, keep Claude working and hand it the failures (JSON on stdout, see bin.ts).
 *
 * Loop guards:
 * - the working tree is fingerprinted, so a turn that changed nothing (Claude only answered a
 *   question) does not re-run the gates;
 * - after `maxBlocks` consecutive blocks Claude is allowed to stop, and the user gets a warning
 *   instead of an endless fix loop.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { GateReport } from '../contracts.js';
import { gateFeedback } from '../report.js';
import { treeFingerprint } from './fingerprint.js';
import { STATE_DIR, runGates } from './run.js';
import type { RunOptions } from './run.js';

export const HOOK_STATE_FILE = join(STATE_DIR, 'hook-state.json');
export const DEFAULT_MAX_BLOCKS = 3;

export interface HookState {
  fingerprint?: string;
  passed: boolean;
  /** Consecutive stops blocked on failing gates. */
  blocks: number;
  checkedAt: string;
}

export interface HookInput {
  stop_hook_active?: boolean;
  cwd?: string;
}

export type HookResponse =
  | { kind: 'allow' }
  /** Let Claude stop, but tell the user something (stdout JSON `systemMessage`). */
  | { kind: 'warn'; message: string }
  /** Keep Claude working; `reason` is what Claude reads. */
  | { kind: 'block'; reason: string };

/** Before running gates: is there anything to check? */
export function precheck(state: HookState | undefined, fingerprint: string | undefined, input: HookInput): HookResponse | undefined {
  if (!fingerprint || !state || state.fingerprint !== fingerprint) return undefined;
  if (state.passed) return { kind: 'allow' };
  // Same tree as a check that already failed. Re-blocking would only repeat the same message.
  if (input.stop_hook_active) {
    return { kind: 'warn', message: 'agent-gates: gates are still failing and nothing changed since the last check. Run `npx agent-gates` to see the report.' };
  }
  return { kind: 'allow' };
}

/** After running gates: block, warn or allow, and the state to persist. */
export function decide(
  report: GateReport,
  state: HookState | undefined,
  input: HookInput,
  maxBlocks: number,
): { response: HookResponse; blocks: number } {
  if (report.passed) return { response: { kind: 'allow' }, blocks: 0 };
  const blocks = input.stop_hook_active ? (state?.blocks ?? 0) + 1 : 1;
  if (blocks > maxBlocks) {
    return {
      response: {
        kind: 'warn',
        message: `agent-gates: gates still fail after ${maxBlocks} fix attempts, so Claude was allowed to stop. Run \`npx agent-gates\` to see what is left.`,
      },
      blocks,
    };
  }
  const reason = [
    `agent-gates: the task is not done. These checks fail (attempt ${blocks} of ${maxBlocks}):`,
    '',
    gateFeedback(report, { issuesPerGate: 10, maxChars: 8000 }),
    '',
    'Fix the causes and finish again; the checks re-run automatically.',
    'Do not edit agent-gates.yaml or agent-gates.baseline.json, and do not disable, skip or weaken a check to make it pass.',
  ].join('\n');
  return { response: { kind: 'block', reason }, blocks };
}

async function readState(cwd: string): Promise<HookState | undefined> {
  try {
    const s = JSON.parse(await readFile(join(cwd, HOOK_STATE_FILE), 'utf8')) as HookState;
    return typeof s.passed === 'boolean' && typeof s.blocks === 'number' ? s : undefined;
  } catch {
    return undefined;
  }
}

async function writeState(cwd: string, state: HookState): Promise<void> {
  await mkdir(join(cwd, STATE_DIR), { recursive: true });
  await writeFile(join(cwd, HOOK_STATE_FILE), `${JSON.stringify(state, null, 2)}\n`);
}

export function parseHookInput(text: string): HookInput {
  try {
    const data: unknown = JSON.parse(text);
    return data && typeof data === 'object' ? (data as HookInput) : {};
  } catch {
    return {};
  }
}

export interface ClaudeHookOptions extends Pick<RunOptions, 'configPath' | 'specPath'> {
  cwd: string;
  input: HookInput;
  maxBlocks?: number;
}

export async function runClaudeHook(opts: ClaudeHookOptions): Promise<HookResponse> {
  const { cwd, input } = opts;
  const maxBlocks = opts.maxBlocks ?? DEFAULT_MAX_BLOCKS;
  const state = await readState(cwd);
  const fingerprint = await treeFingerprint(cwd, STATE_DIR);
  const early = precheck(state, fingerprint, input);
  if (early) return early;

  const runOpts: RunOptions = { cwd };
  if (opts.configPath) runOpts.configPath = opts.configPath;
  if (opts.specPath) runOpts.specPath = opts.specPath;
  const { report } = await runGates(runOpts);
  const { response, blocks } = decide(report, state, input, maxBlocks);
  // Fingerprint after the run: gates (build, screenshots) may touch untracked files themselves.
  const after = await treeFingerprint(cwd, STATE_DIR);
  const next: HookState = { passed: report.passed, blocks, checkedAt: new Date().toISOString() };
  if (after) next.fingerprint = after;
  await writeState(cwd, next);
  return response;
}
