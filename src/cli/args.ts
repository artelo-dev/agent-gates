/** Minimal argv parser: `--flag`, `--key value`, `--key=value`, `-h`, positionals. No dependencies. */

export interface ParsedArgs {
  positionals: string[];
  flags: Map<string, string | true>;
}

const SHORT: Readonly<Record<string, string>> = { h: 'help', v: 'version', c: 'config' };

/** Flags that take a value (everything else is boolean). */
const VALUE_FLAGS = new Set(['config', 'cwd', 'spec', 'out', 'max-blocks', 'output']);

export class UsageError extends Error {}

export function parseArgs(argv: readonly string[]): ParsedArgs {
  const positionals: string[] = [];
  const flags = new Map<string, string | true>();
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] as string;
    if (arg === '--') {
      positionals.push(...argv.slice(i + 1));
      break;
    }
    if (arg.startsWith('--')) {
      const eq = arg.indexOf('=');
      const name = eq === -1 ? arg.slice(2) : arg.slice(2, eq);
      if (eq !== -1) flags.set(name, arg.slice(eq + 1));
      else if (VALUE_FLAGS.has(name)) {
        const value = argv[i + 1];
        if (value === undefined || value.startsWith('-')) throw new UsageError(`--${name} needs a value`);
        flags.set(name, value);
        i++;
      } else flags.set(name, true);
      continue;
    }
    if (arg.startsWith('-') && arg.length === 2) {
      const name = SHORT[arg[1] as string];
      if (!name) throw new UsageError(`unknown option ${arg}`);
      if (VALUE_FLAGS.has(name)) {
        const value = argv[i + 1];
        if (value === undefined) throw new UsageError(`${arg} needs a value`);
        flags.set(name, value);
        i++;
      } else flags.set(name, true);
      continue;
    }
    positionals.push(arg);
  }
  return { positionals, flags };
}

export function flagString(args: ParsedArgs, name: string): string | undefined {
  const v = args.flags.get(name);
  return typeof v === 'string' ? v : undefined;
}

export function flagBool(args: ParsedArgs, name: string): boolean {
  return args.flags.has(name);
}

/** Reject flags the command does not know, so typos fail loudly instead of being ignored. */
export function assertKnownFlags(args: ParsedArgs, known: readonly string[]): void {
  for (const name of args.flags.keys()) {
    if (!known.includes(name)) throw new UsageError(`unknown option --${name}`);
  }
}
