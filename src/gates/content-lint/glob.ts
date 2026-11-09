/**
 * Minimal glob → RegExp for include/exclude lists (no dependency). Paths are POSIX-relative.
 * Supports `**`, `*`, `?`, `{a,b}`; a pattern without `/` matches at any depth (gitignore-style).
 */
export function globToRegExp(glob: string): RegExp {
  let pattern = glob.trim().replace(/^\.\//, '');
  if (pattern.endsWith('/')) pattern += '**';
  if (!pattern.includes('/')) pattern = `**/${pattern}`;
  let re = '';
  let braceDepth = 0;
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i] as string;
    if (ch === '*') {
      if (pattern[i + 1] === '*') {
        const slashAfter = pattern[i + 2] === '/';
        re += slashAfter ? '(?:.*/)?' : '.*';
        i += slashAfter ? 2 : 1;
      } else {
        re += '[^/]*';
      }
    } else if (ch === '?') re += '[^/]';
    else if (ch === '{') {
      braceDepth++;
      re += '(?:';
    } else if (ch === '}' && braceDepth > 0) {
      braceDepth--;
      re += ')';
    } else if (ch === ',' && braceDepth > 0) re += '|';
    else re += ch.replace(/[.+^$()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`);
}

export class GlobSet {
  private readonly res: RegExp[];
  constructor(globs: readonly string[]) {
    this.res = globs.map(globToRegExp);
  }
  get size(): number {
    return this.res.length;
  }
  matches(path: string): boolean {
    return this.res.some((re) => re.test(path));
  }
  /** True when every file below `dir` would match (lets the walker prune whole directories). */
  matchesDir(dir: string): boolean {
    return this.matches(`${dir}/\u0000probe`) || this.matches(dir);
  }
}
