/** Facts about the project being checked: package manager, scripts, config files. */
import { readFile, stat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import type { CommandSpec, ProjectInfo, ToolProbe } from './types.js';

export async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

export async function firstExisting(cwd: string, names: readonly string[]): Promise<string | undefined> {
  for (const name of names) {
    if (await pathExists(join(cwd, name))) return name;
  }
  return undefined;
}

/**
 * Look for any of `names` in `cwd` and its ancestors, stopping after the first directory that
 * contains `.git` (the repo / worktree root). Returns the absolute path of the first match.
 */
export async function findUp(cwd: string, names: readonly string[]): Promise<string | undefined> {
  let dir = resolve(cwd);
  for (;;) {
    const hit = await firstExisting(dir, names);
    if (hit) return join(dir, hit);
    const parent = dirname(dir);
    if (parent === dir || (await pathExists(join(dir, '.git')))) return undefined;
    dir = parent;
  }
}

const LOCKFILES:ReadonlyArray<[string, ProjectInfo['packageManager']]> = [
  ['pnpm-lock.yaml', 'pnpm'],
  ['bun.lockb', 'bun'],
  ['bun.lock', 'bun'],
  ['yarn.lock', 'yarn'],
  ['package-lock.json', 'npm'],
];

export async function detectProject(cwd: string): Promise<ProjectInfo> {
  let packageManager: ProjectInfo['packageManager'] = 'npm';
  for (const [file, pm] of LOCKFILES) {
    if (await pathExists(join(cwd, file))) {
      packageManager = pm;
      break;
    }
  }
  let scripts: Record<string, string> = {};
  let hasPackageJson = false;
  try {
    const pkg = JSON.parse(await readFile(join(cwd, 'package.json'), 'utf8')) as {
      scripts?: Record<string, unknown>;
      packageManager?: string;
    };
    hasPackageJson = true;
    if (pkg.scripts && typeof pkg.scripts === 'object') {
      scripts = Object.fromEntries(
        Object.entries(pkg.scripts).filter((e): e is [string, string] => typeof e[1] === 'string'),
      );
    }
    const declared = pkg.packageManager?.split('@')[0];
    if (declared === 'pnpm' || declared === 'npm' || declared === 'yarn' || declared === 'bun') {
      packageManager = declared;
    }
  } catch {
    /* no or invalid package.json */
  }
  return { cwd, packageManager, scripts, hasPackageJson };
}

/** `<pm> run <script>` */
export function runScriptCommand(project: ProjectInfo, script: string): CommandSpec {
  return { command: project.packageManager, args: ['run', script] };
}

/** True for npm's placeholder `echo "Error: no test specified" && exit 1`. */
export function isPlaceholderTestScript(script: string | undefined): boolean {
  return script === undefined || /no test specified/i.test(script);
}

/**
 * Command for a project-local tool: the resolved bin when found, else `npx --no-install <name>`
 * (never downloads anything).
 */
export async function toolCommand(probe: ToolProbe, cwd: string, name: string, args: string[]): Promise<CommandSpec> {
  const bin = await probe.findBin(name, cwd);
  return bin ? { command: bin, args } : { command: 'npx', args: ['--no-install', name, ...args] };
}

export const TSCONFIG_FILES = ['tsconfig.json'] as const;

export const ESLINT_CONFIG_FILES = [
  'eslint.config.js',
  'eslint.config.mjs',
  'eslint.config.cjs',
  'eslint.config.ts',
  'eslint.config.mts',
  'eslint.config.cts',
  '.eslintrc',
  '.eslintrc.js',
  '.eslintrc.cjs',
  '.eslintrc.json',
  '.eslintrc.yaml',
  '.eslintrc.yml',
] as const;
