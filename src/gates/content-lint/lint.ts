/**
 * Content lint over a project's source/content files, fully in TypeScript (no external tool).
 *
 * Suppression: a line containing `content-lint-ignore` is skipped; a file whose first 5 lines
 * contain `content-lint-ignore-file` is skipped entirely.
 */
import { execFile } from 'node:child_process';
import { open, readdir } from 'node:fs/promises';
import { extname, join, posix, sep } from 'node:path';
import { GlobSet } from './glob.js';
import { BUILTIN_CONTENT_RULES, customRules } from './rules.js';
import type { ContentRule } from './rules.js';

export const CODE_EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.mts', '.cts', '.vue', '.svelte', '.astro'];
export const CONTENT_EXTENSIONS = ['.md', '.mdx', '.json', '.html', '.htm', '.txt', '.yaml', '.yml'];

/** Directory names never descended into. */
export const IGNORED_DIRS = new Set([
  'node_modules',
  '.git',
  '.next',
  '.nuxt',
  '.svelte-kit',
  '.vercel',
  '.turbo',
  '.cache',
  '.artelo',
  '.agent-gates',
  'dist',
  'build',
  'out',
  'coverage',
  'playwright-report',
  'test-results',
]);

/** Default excludes: tests legitimately use example.com addresses; specs hold unfilled placeholders by design. */
export const DEFAULT_EXCLUDES = [
  '**/*.test.*',
  '**/*.spec.*',
  '**/__tests__/**',
  'e2e/**',
  'tests/**',
  'test/**',
  'specs/**',
  '**/*.d.ts',
  'playwright.config.*',
  'package-lock.json',
  'pnpm-lock.yaml',
  'yarn.lock',
  'bun.lock',
  // agent-gates' own files name the very patterns they forbid.
  'agent-gates.yaml',
  'agent-gates.yml',
  '.agent-gates.yaml',
  'agent-gates.baseline.json',
];

const MAX_FILE_BYTES = 1024 * 1024;
const MAX_FILES = 20_000;

export interface ContentFinding {
  rule: string;
  message: string;
  /** POSIX path relative to the scanned root. */
  file: string;
  line: number;
  column: number;
  /** The matched text. */
  match: string;
  /** The trimmed source line (max 200 chars). */
  excerpt: string;
}

export interface ContentLintOptions {
  /** Globs to include (default: every file with a code/content extension). */
  include?: readonly string[];
  /** Extra globs to exclude (added to DEFAULT_EXCLUDES unless `replaceDefaultExcludes`). */
  exclude?: readonly string[];
  replaceDefaultExcludes?: boolean;
  /** Extra forbidden regex sources. */
  patterns?: readonly string[];
  /** Built-in rule ids to turn off (`lorem`, `todo`, `example-domain`, `empty-href`, `placeholder`). */
  disableRules?: readonly string[];
  signal?: AbortSignal;
  /** In a git repo, scan only files git would track (respects .gitignore). Default true. */
  respectGitignore?: boolean;
}

export interface ContentLintResult {
  findings: ContentFinding[];
  filesScanned: number;
  /** True when MAX_FILES was hit. */
  truncated: boolean;
}

function toPosix(p: string): string {
  return sep === '/' ? p : p.split(sep).join('/');
}

async function* walk(root: string, exclude: GlobSet, rel = ''): AsyncGenerator<string> {
  const entries = await readdir(join(root, rel), { withFileTypes: true });
  entries.sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) {
    const relPath = rel ? posix.join(rel, entry.name) : entry.name;
    if (entry.isDirectory()) {
      if (IGNORED_DIRS.has(entry.name) || exclude.matchesDir(relPath)) continue;
      yield* walk(root, exclude, relPath);
    } else if (entry.isFile()) {
      yield relPath;
    }
  }
}

/**
 * Files under `root` that git tracks or would track (cached + untracked, minus .gitignore), as
 * POSIX paths relative to `root`. Undefined when `root` is not inside a git work tree.
 */
export function gitListFiles(root: string): Promise<string[] | undefined> {
  return new Promise((resolve) => {
    execFile(
      'git',
      ['ls-files', '-z', '--cached', '--others', '--exclude-standard', '--', '.'],
      { cwd: root, maxBuffer: 256 * 1024 * 1024, encoding: 'buffer' },
      (err, stdout) => {
        if (err) return resolve(undefined);
        const files = stdout.toString('utf8').split('\0').filter(Boolean);
        resolve([...new Set(files)].sort());
      },
    );
  });
}

function inIgnoredDir(relPath: string, exclude: GlobSet): boolean {
  const parts = relPath.split('/');
  for (let i = 0; i < parts.length - 1; i++) {
    if (IGNORED_DIRS.has(parts[i] as string) || exclude.matchesDir(parts.slice(0, i + 1).join('/'))) return true;
  }
  return false;
}

async function* listFiles(root: string, exclude: GlobSet, useGit: boolean): AsyncGenerator<string> {
  const tracked = useGit ? await gitListFiles(root) : undefined;
  if (!tracked) {
    yield* walk(root, exclude);
    return;
  }
  for (const rel of tracked) if (!inIgnoredDir(rel, exclude)) yield rel;
}

async function readTextFile(path: string): Promise<string | undefined> {
  let fh;
  try {
    fh = await open(path, 'r');
  } catch (err) {
    // Tracked but deleted in the working tree, or not a regular file.
    if ((err as NodeJS.ErrnoException).code === 'ENOENT' || (err as NodeJS.ErrnoException).code === 'EISDIR') return undefined;
    throw err;
  }
  try {
    const { size } = await fh.stat();
    if (size > MAX_FILE_BYTES) return undefined;
    const buf = await fh.readFile();
    if (buf.subarray(0, 8192).includes(0)) return undefined;
    return buf.toString('utf8');
  } finally {
    await fh.close();
  }
}

function lineStarts(text: string): number[] {
  const starts = [0];
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) starts.push(i + 1);
  return starts;
}

function locate(starts: number[], index: number): { line: number; column: number } {
  let lo = 0;
  let hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if ((starts[mid] as number) <= index) lo = mid;
    else hi = mid - 1;
  }
  return { line: lo + 1, column: index - (starts[lo] as number) + 1 };
}

/** Lint one file's text. Exposed for tests and for linting in-memory content. */
export function lintText(file: string, text: string, rules: readonly ContentRule[] = BUILTIN_CONTENT_RULES): ContentFinding[] {
  const head = text.split('\n', 5).join('\n');
  if (head.includes('content-lint-ignore-file')) return [];
  const isCode = CODE_EXTENSIONS.includes(extname(file).toLowerCase());
  const starts = lineStarts(text);
  const lines = text.split('\n');
  const findings: ContentFinding[] = [];
  for (const rule of rules) {
    const re = new RegExp(rule.pattern.source, rule.pattern.flags.includes('g') ? rule.pattern.flags : `${rule.pattern.flags}g`);
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      if (m[0] === '') {
        re.lastIndex++;
        continue;
      }
      const { line, column } = locate(starts, m.index);
      const sourceLine = lines[line - 1] ?? '';
      if (sourceLine.includes('content-lint-ignore')) continue;
      if (rule.accept && !rule.accept(m, { text, isCode, path: file })) continue;
      findings.push({
        rule: rule.id,
        message: rule.message,
        file,
        line,
        column,
        match: m[0],
        excerpt: sourceLine.trim().slice(0, 200),
      });
    }
  }
  return findings.sort((a, b) => a.line - b.line || a.column - b.column);
}

export function buildRules(opts: Pick<ContentLintOptions, 'patterns' | 'disableRules'>): ContentRule[] {
  const disabled = new Set(opts.disableRules ?? []);
  return [...BUILTIN_CONTENT_RULES.filter((r) => !disabled.has(r.id)), ...customRules(opts.patterns ?? [])];
}

/** Lint every source/content file under `root`. */
export async function lintContent(root: string, opts: ContentLintOptions = {}): Promise<ContentLintResult> {
  const exclude = new GlobSet([...(opts.replaceDefaultExcludes ? [] : DEFAULT_EXCLUDES), ...(opts.exclude ?? [])]);
  const include = opts.include && opts.include.length > 0 ? new GlobSet(opts.include) : undefined;
  const extensions = new Set([...CODE_EXTENSIONS, ...CONTENT_EXTENSIONS]);
  const rules = buildRules(opts);
  const findings: ContentFinding[] = [];
  let filesScanned = 0;
  let truncated = false;
  for await (const rel of listFiles(root, exclude, opts.respectGitignore !== false)) {
    if (opts.signal?.aborted) throw new Error('aborted');
    if (exclude.matches(rel)) continue;
    if (include ? !include.matches(rel) : !extensions.has(extname(rel).toLowerCase())) continue;
    if (filesScanned >= MAX_FILES) {
      truncated = true;
      break;
    }
    const text = await readTextFile(join(root, rel));
    if (text === undefined) continue;
    filesScanned++;
    findings.push(...lintText(toPosix(rel), text, rules));
  }
  return { findings, filesScanned, truncated };
}
