/** Filesystem-based tool probing: local node_modules/.bin first (cwd and ancestors), then PATH. */
import { constants } from 'node:fs';
import { access, stat } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { delimiter, dirname, join, resolve } from 'node:path';
import type { ToolProbe } from '../types.js';

async function isExecutable(path: string): Promise<boolean> {
  try {
    const s = await stat(path);
    if (!s.isFile()) return false;
    await access(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function ancestors(start: string): string[] {
  const dirs: string[] = [];
  let dir = resolve(start);
  for (;;) {
    dirs.push(dir);
    const parent = dirname(dir);
    if (parent === dir) return dirs;
    dir = parent;
  }
}

export class FsToolProbe implements ToolProbe {
  constructor(private readonly pathEnv: string = process.env.PATH ?? '') {}

  async findBin(name: string, cwd: string): Promise<string | undefined> {
    for (const dir of ancestors(cwd)) {
      const candidate = join(dir, 'node_modules', '.bin', name);
      if (await isExecutable(candidate)) return candidate;
    }
    for (const dir of this.pathEnv.split(delimiter).filter(Boolean)) {
      const candidate = join(dir, name);
      if (await isExecutable(candidate)) return candidate;
    }
    return undefined;
  }

  async hasModule(name: string, cwd: string): Promise<boolean> {
    try {
      createRequire(join(resolve(cwd), 'noop.js')).resolve(`${name}/package.json`);
      return true;
    } catch {
      // Packages with a strict `exports` map may hide package.json; fall back to a directory check.
      for (const dir of ancestors(cwd)) {
        try {
          const s = await stat(join(dir, 'node_modules', name, 'package.json'));
          if (s.isFile()) return true;
        } catch {
          /* keep looking */
        }
      }
      return false;
    }
  }
}
