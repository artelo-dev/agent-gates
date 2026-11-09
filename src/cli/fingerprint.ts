/**
 * A fingerprint of the working tree, so the Stop hook can skip re-running gates when nothing
 * changed since the last check (e.g. the agent only answered a question).
 *
 * Covers HEAD, the diff of tracked files against HEAD, and size + mtime of untracked files.
 * Our own state dir is excluded. Returns undefined outside a git repo: then gates always run.
 */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { stat } from 'node:fs/promises';
import { join } from 'node:path';

function git(cwd: string, args: string[]): Promise<{ code: number | null; stdout: Buffer }> {
  return new Promise((resolve) => {
    const child = spawn('git', args, { cwd, stdio: ['ignore', 'pipe', 'ignore'] });
    const chunks: Buffer[] = [];
    child.stdout.on('data', (c: Buffer) => chunks.push(c));
    child.on('error', () => resolve({ code: null, stdout: Buffer.alloc(0) }));
    child.on('close', (code) => resolve({ code, stdout: Buffer.concat(chunks) }));
  });
}

export async function treeFingerprint(cwd: string, excludeDir: string): Promise<string | undefined> {
  const inside = await git(cwd, ['rev-parse', '--is-inside-work-tree']);
  if (inside.code !== 0 || inside.stdout.toString().trim() !== 'true') return undefined;
  const hash = createHash('sha256');
  const exclude = `:(exclude)${excludeDir}`;
  const head = await git(cwd, ['rev-parse', '--verify', '-q', 'HEAD']);
  hash.update(head.code === 0 ? head.stdout : Buffer.from('no-head'));
  // Unborn branch: diff against the empty tree.
  const base = head.code === 0 ? 'HEAD' : '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
  const diff = await git(cwd, ['diff', '--binary', '--no-color', '--no-ext-diff', base, '--', '.', exclude]);
  if (diff.code !== 0) return undefined;
  hash.update(diff.stdout);
  const untracked = await git(cwd, ['ls-files', '--others', '--exclude-standard', '-z', '--', '.', exclude]);
  if (untracked.code !== 0) return undefined;
  const files = untracked.stdout.toString('utf8').split('\0').filter(Boolean).sort();
  for (const file of files) {
    hash.update(`\0${file}\0`);
    try {
      const s = await stat(join(cwd, file));
      hash.update(`${s.size}:${s.mtimeMs}`);
    } catch {
      hash.update('missing');
    }
  }
  return hash.digest('hex');
}
