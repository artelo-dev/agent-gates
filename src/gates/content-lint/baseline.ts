/**
 * Content-lint baseline: findings that already existed when the baseline was recorded are
 * ignored, so an existing repo can adopt the gate on day one and only NEW lorem/TODO/placeholder
 * text fails it. A finding is keyed by file + rule + matched text + source line, not by line
 * number, so it survives code moving around in the file. Counts are kept: if a file had two
 * identical TODO lines and now has three, one is new.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { ContentFinding } from './lint.js';

export interface ContentBaseline {
  version: 1;
  /** Finding key → how many times it occurred when the baseline was recorded. */
  findings: Record<string, number>;
}

export function findingKey(f: Pick<ContentFinding, 'file' | 'rule' | 'match' | 'excerpt'>): string {
  return [f.file, f.rule, f.match, f.excerpt].join('␟');
}

export function buildBaseline(findings: readonly ContentFinding[]): ContentBaseline {
  const counts: Record<string, number> = {};
  for (const f of findings) {
    const key = findingKey(f);
    counts[key] = (counts[key] ?? 0) + 1;
  }
  const sorted = Object.fromEntries(Object.entries(counts).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
  return { version: 1, findings: sorted };
}

/** Findings not covered by the baseline (in their original order). */
export function newFindings(findings: readonly ContentFinding[], baseline: ContentBaseline): ContentFinding[] {
  const remaining = { ...baseline.findings };
  const out: ContentFinding[] = [];
  for (const f of findings) {
    const key = findingKey(f);
    const left = remaining[key] ?? 0;
    if (left > 0) remaining[key] = left - 1;
    else out.push(f);
  }
  return out;
}

export class BaselineError extends Error {}

/** Read a baseline file. A missing file is an error: a configured baseline that vanished must not silently pass. */
export async function readBaseline(path: string): Promise<ContentBaseline> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') throw new BaselineError(`baseline file not found: ${path}`);
    throw err;
  }
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch (err) {
    throw new BaselineError(`baseline file is not valid JSON: ${path} (${(err as Error).message})`);
  }
  const d = data as Partial<ContentBaseline>;
  if (d?.version !== 1 || typeof d.findings !== 'object' || d.findings === null) {
    throw new BaselineError(`unsupported baseline format in ${path}`);
  }
  for (const [key, n] of Object.entries(d.findings)) {
    if (typeof n !== 'number' || !Number.isInteger(n) || n < 1) throw new BaselineError(`bad count for ${JSON.stringify(key)} in ${path}`);
  }
  return d as ContentBaseline;
}

export async function writeBaseline(path: string, baseline: ContentBaseline): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(baseline, null, 2)}\n`);
}
