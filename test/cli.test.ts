import { execFileSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { parseArgs, UsageError } from '../src/cli/args.js';
import { autoConfig, detectGates } from '../src/cli/detect.js';
import { treeFingerprint } from '../src/cli/fingerprint.js';
import { decide, precheck } from '../src/cli/hook.js';
import type { HookState } from '../src/cli/hook.js';
import { addStopHook, agentsBlock, BASELINE_FILE, renderConfig, runInit, upsertAgentsBlock } from '../src/cli/init.js';
import { parseGatesYaml } from '../src/config.js';
import type { GateReport, GateResult } from '../src/contracts.js';
import { buildBaseline, newFindings, readBaseline, BaselineError } from '../src/gates/content-lint/baseline.js';
import { lintContent, lintText } from '../src/gates/content-lint/lint.js';
import { aggregateReport } from '../src/report.js';
import { FakeProbe, makeTempDir, writeFiles } from './helpers.js';

let cleanup: (() => Promise<void>) | undefined;
afterEach(async () => {
  await cleanup?.();
  cleanup = undefined;
});

async function tempProject(files: Record<string, string>): Promise<string> {
  const tmp = await makeTempDir();
  cleanup = tmp.cleanup;
  await writeFiles(tmp.dir, files);
  return tmp.dir;
}

function git(cwd: string, ...args: string[]): void {
  execFileSync('git', args, { cwd, stdio: 'ignore' });
}

function initRepo(cwd: string): void {
  git(cwd, 'init', '-q');
  git(cwd, 'add', '-A');
  git(cwd, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'init', '--allow-empty');
}

describe('parseArgs', () => {
  it('reads positionals, boolean and value flags in every spelling', () => {
    const a = parseArgs(['tsc', '--json', '--config', 'x.yaml', '--out=dir', '-c', 'y.yaml', 'eslint']);
    expect(a.positionals).toEqual(['tsc', 'eslint']);
    expect(a.flags.get('json')).toBe(true);
    expect(a.flags.get('config')).toBe('y.yaml');
    expect(a.flags.get('out')).toBe('dir');
  });

  it('rejects a value flag without a value and unknown short flags', () => {
    expect(() => parseArgs(['--config'])).toThrow(UsageError);
    expect(() => parseArgs(['--config', '--json'])).toThrow(UsageError);
    expect(() => parseArgs(['-x'])).toThrow(UsageError);
  });
});

describe('detectGates', () => {
  it('turns on only the gates the project can run', async () => {
    const dir = await tempProject({
      'package.json': JSON.stringify({ scripts: { build: 'tsc', test: 'vitest run' } }),
      'tsconfig.json': '{}',
    });
    const d = await detectGates(dir, new FakeProbe());
    const on = d.decisions.filter((x) => x.enabled).map((x) => x.gate);
    expect(on).toEqual(['tsc', 'content-lint', 'build', 'tests']);
    expect(d.web).toBeUndefined();
    expect(Object.keys(autoConfig(d).gates)).toEqual(['tsc', 'content-lint', 'build', 'tests']);
    expect(autoConfig(d).gates.tsc).toEqual({ required: true, allowSkip: false });
  });

  it('ignores npm’s placeholder test script', async () => {
    const dir = await tempProject({ 'package.json': JSON.stringify({ scripts: { test: 'echo "Error: no test specified" && exit 1' } }) });
    const d = await detectGates(dir, new FakeProbe());
    expect(d.decisions.find((x) => x.gate === 'tests')?.enabled).toBe(false);
  });

  it('enables browser gates for a web app only when their packages are installed', async () => {
    const pkg = (dev: Record<string, string>) =>
      JSON.stringify({ scripts: { build: 'next build', start: 'next start' }, dependencies: { next: '16.0.0' }, devDependencies: dev });
    let dir = await tempProject({ 'package.json': pkg({}) });
    let d = await detectGates(dir, new FakeProbe());
    expect(d.decisions.filter((x) => x.browser && x.enabled)).toEqual([]);
    expect(d.decisions.find((x) => x.gate === 'visual')?.reason).toMatch(/@playwright\/test/);
    await cleanup?.();

    dir = await tempProject({ 'package.json': pkg({ '@playwright/test': '1', '@axe-core/playwright': '4' }) });
    d = await detectGates(dir, new FakeProbe());
    expect(d.decisions.filter((x) => x.browser && x.enabled).map((x) => x.gate)).toEqual(['axe', 'visual']);
    expect(d.decisions.find((x) => x.gate === 'lighthouse')?.enabled).toBe(false);
    // Browser gates never run in auto mode; init writes them.
    expect(Object.keys(autoConfig(d).gates)).not.toContain('axe');
  });
});

describe('init', () => {
  it('renders a config that parses back with the same gates switched on', async () => {
    const dir = await tempProject({ 'package.json': JSON.stringify({ scripts: { build: 'x' } }), 'tsconfig.json': '{}' });
    const d = await detectGates(dir, new FakeProbe());
    const config = parseGatesYaml(renderConfig(d, { baseline: BASELINE_FILE }));
    expect(config.gates.tsc).toMatchObject({ allowSkip: false });
    expect(config.gates.eslint).toMatchObject({ enabled: false });
    expect(config.gates['content-lint']).toMatchObject({ baseline: BASELINE_FILE });
  });

  it('writes config, baseline, gitignore, Claude hook, AGENTS.md and CI, and is idempotent', async () => {
    const dir = await tempProject({
      'package.json': JSON.stringify({ scripts: { build: 'x' } }),
      'src/app.ts': 'export const a = 1; // TODO wire up\n',
      '.claude/settings.json': JSON.stringify({ permissions: { allow: ['Bash(ls)'] } }),
      'AGENTS.md': '# Rules\n\nBe nice.\n',
    });
    const first = await runInit({ cwd: dir, claude: true, agentsMd: true, github: true, probe: new FakeProbe() });
    expect(first.steps.map((s) => `${s.action} ${s.file}`)).toEqual([
      `created ${BASELINE_FILE}`,
      'created agent-gates.yaml',
      'created .gitignore',
      'updated .claude/settings.json',
      'updated AGENTS.md',
      'created .github/workflows/agent-gates.yml',
    ]);
    const settings = JSON.parse(await readFile(join(dir, '.claude/settings.json'), 'utf8'));
    expect(settings.permissions).toEqual({ allow: ['Bash(ls)'] });
    expect(settings.hooks.Stop[0].hooks[0]).toMatchObject({ type: 'command', timeout: 900 });
    expect(settings.hooks.Stop[0].hooks[0].command).toMatch(/^npx --yes agent-gates@\S+ hook claude$/);
    const agents = await readFile(join(dir, 'AGENTS.md'), 'utf8');
    expect(agents.startsWith('# Rules\n\nBe nice.\n\n<!-- agent-gates:start -->')).toBe(true);
    expect(await readFile(join(dir, '.gitignore'), 'utf8')).toBe('.agent-gates/\n');

    const again = await runInit({ cwd: dir, claude: true, agentsMd: true, github: true, probe: new FakeProbe() });
    expect(again.steps.map((s) => s.action)).toEqual(['skipped', 'unchanged', 'unchanged', 'unchanged', 'skipped']);
  });

  it('uses the local install in the hook when there is one', async () => {
    const dir = await tempProject({ 'package.json': '{}' });
    const r = await runInit({ cwd: dir, probe: new FakeProbe({ 'agent-gates': '/x/node_modules/.bin/agent-gates' }) });
    expect(r.hookCommand).toBe('npx --no-install agent-gates hook claude');
  });

  it('addStopHook keeps other Stop hooks and updates its own entry in place', () => {
    const settings: Record<string, unknown> = { hooks: { Stop: [{ hooks: [{ type: 'command', command: 'echo bye' }] }] } };
    expect(addStopHook(settings, 'npx --yes agent-gates@0.1.0 hook claude')).toBe(true);
    expect(addStopHook(settings, 'npx --yes agent-gates@0.1.0 hook claude')).toBe(false);
    expect(addStopHook(settings, 'npx --no-install agent-gates hook claude')).toBe(true);
    const stop = (settings.hooks as { Stop: Array<{ hooks: Array<{ command: string }> }> }).Stop;
    expect(stop.flatMap((g) => g.hooks.map((h) => h.command))).toEqual(['echo bye', 'npx --no-install agent-gates hook claude']);
  });

  it('upsertAgentsBlock replaces its own block and leaves the rest alone', () => {
    const once = upsertAgentsBlock('# A\n', 'npx agent-gates');
    const twice = upsertAgentsBlock(`${once}\n## B\n`, 'npx --yes agent-gates@9.9.9');
    expect(twice).toContain('`npx --yes agent-gates@9.9.9`');
    expect(twice).not.toContain('`npx agent-gates`');
    expect(twice.match(/agent-gates:start/g)).toHaveLength(1);
    expect(twice.endsWith('## B\n')).toBe(true);
    expect(upsertAgentsBlock('')).toBe(`${agentsBlock()}\n`);
  });
});

describe('content-lint baseline', () => {
  it('ignores known findings, keeps counts, and survives line moves', () => {
    const before = lintText('a.tsx', '<p>TODO</p>\n<p>TODO</p>\n');
    const baseline = buildBaseline(before);
    const moved = lintText('a.tsx', '\n\n<p>TODO</p>\n<p>TODO</p>\n');
    expect(newFindings(moved, baseline)).toEqual([]);
    const more = lintText('a.tsx', '<p>TODO</p>\n<p>TODO</p>\n<p>TODO</p>\n<p>lorem</p>\n');
    expect(newFindings(more, baseline).map((f) => `${f.rule}:${f.line}`)).toEqual(['todo:3', 'lorem:4']);
  });

  it('fails loudly on a missing or malformed baseline', async () => {
    const dir = await tempProject({ 'bad.json': '{"version":2}', 'neg.json': '{"version":1,"findings":{"k":0}}' });
    await expect(readBaseline(join(dir, 'nope.json'))).rejects.toThrow(BaselineError);
    await expect(readBaseline(join(dir, 'bad.json'))).rejects.toThrow(/unsupported/);
    await expect(readBaseline(join(dir, 'neg.json'))).rejects.toThrow(/bad count/);
  });
});

describe('placeholder copy rules', () => {
  const hits = (file: string, text: string) => lintText(file, text).filter((f) => f.rule === 'placeholder-text' || f.rule === 'fill-in-text').length;

  it.each([
    ['a.tsx', '<p>Placeholder eyebrow</p>'],
    ['a.tsx', '<p>\n  Placeholder supporting line.\n</p>'],
    ['a.tsx', 'const title = "Placeholder title";'],
    ['a.tsx', '<h1>Your headline here</h1>'],
    ['a.tsx', '<p>Insert testimonial text here</p>'],
    ['c.json', '{"headline": "Placeholder headline"}'],
    ['c.yaml', 'title: Placeholder title'],
    ['c.html', '<h2>Placeholder</h2>'],
  ])('flags %s %j', (file, text) => expect(hits(file, text)).toBeGreaterThan(0));

  it.each([
    ['a.tsx', '<input placeholder="Your email" />'],
    ['a.tsx', 'const p = e.target.placeholder;'],
    ['a.tsx', 'className="placeholder:text-gray-400"'],
    ['a.css', 'input::placeholder { color: red }'],
    ['a.tsx', 'type Props = { placeholder?: string }'],
    ['a.tsx', "fields: { name: 'placeholder' } as const"],
    ['a.tsx', "import { SectionPlaceholder } from './sections/placeholder';"],
    ['a.tsx', 'const PLACEHOLDER = /x/g;'],
    ['a.tsx', '/** Placeholder copy until final text. */'],
    ['a.tsx', '// placeholders vs status'],
    ['a.tsx', 'const msg = "no placeholder links";'],
    ['c.json', '{"placeholder": "Email"}'],
    ['c.json', '{"path": "components/placeholder.tsx"}'],
    ['c.yaml', '- no lorem ipsum, TODO or placeholder text'],
    ['c.md', 'Placeholder text in a doc'],
    ['a.tsx', 'Click here to see your orders'],
  ])('leaves %s %j alone', (file, text) => expect(hits(file, text)).toBe(0));
});

describe('content-lint file listing', () => {
  it('skips files git ignores, including custom build dirs', async () => {
    const dir = await tempProject({
      '.gitignore': '/.next-early/\n',
      'src/page.tsx': '<p>Lorem ipsum</p>\n',
      '.next-early/server/chunk.js': 'href="#"\n',
    });
    initRepo(dir);
    const viaGit = await lintContent(dir);
    expect(viaGit.findings.map((f) => f.file)).toEqual(['src/page.tsx']);
    const walked = await lintContent(dir, { respectGitignore: false });
    expect(walked.findings.map((f) => f.file).sort()).toEqual(['.next-early/server/chunk.js', 'src/page.tsx']);
  });

  it('never lints its own config and baseline files', async () => {
    const dir = await tempProject({ 'agent-gates.yaml': '# lorem ipsum, TODO, example.com\n', [BASELINE_FILE]: '{"k":"TODO"}' });
    expect((await lintContent(dir)).findings).toEqual([]);
  });
});

describe('treeFingerprint', () => {
  it('changes with tracked edits and untracked files, ignores the state dir, is undefined outside git', async () => {
    const dir = await tempProject({ 'a.ts': 'export const a = 1;\n' });
    expect(await treeFingerprint(dir, '.agent-gates')).toBeUndefined();
    initRepo(dir);
    const clean = await treeFingerprint(dir, '.agent-gates');
    expect(clean).toMatch(/^[0-9a-f]{64}$/);
    await writeFiles(dir, { '.agent-gates/hook-state.json': '{}' });
    expect(await treeFingerprint(dir, '.agent-gates')).toBe(clean);
    await writeFile(join(dir, 'a.ts'), 'export const a = 2;\n');
    const edited = await treeFingerprint(dir, '.agent-gates');
    expect(edited).not.toBe(clean);
    await writeFiles(dir, { 'b.ts': 'x' });
    expect(await treeFingerprint(dir, '.agent-gates')).not.toBe(edited);
  });
});

describe('Claude Stop hook decisions', () => {
  const report = (status: GateResult['status']): GateReport =>
    aggregateReport({
      runId: 'r',
      startedAt: 't',
      finishedAt: 't',
      results: [{ gate: 'tsc', status, summary: status === 'failed' ? '1 type error' : 'ok', durationMs: 1, issues: [] }],
    });
  const state = (s: Partial<HookState>): HookState => ({ passed: false, blocks: 0, checkedAt: 't', fingerprint: 'f', ...s });

  it('skips the run when the tree is unchanged since the last check', () => {
    expect(precheck(state({ passed: true }), 'f', {})).toEqual({ kind: 'allow' });
    expect(precheck(state({ passed: false }), 'f', { stop_hook_active: false })).toEqual({ kind: 'allow' });
    expect(precheck(state({ passed: false }), 'f', { stop_hook_active: true })?.kind).toBe('warn');
    expect(precheck(state({ passed: true }), 'other', {})).toBeUndefined();
    expect(precheck(state({ passed: true }), undefined, {})).toBeUndefined();
  });

  it('blocks with the failures, counts consecutive blocks, then lets the agent stop with a warning', () => {
    const first = decide(report('failed'), undefined, { stop_hook_active: false }, 3);
    expect(first.blocks).toBe(1);
    expect(first.response.kind).toBe('block');
    if (first.response.kind === 'block') {
      expect(first.response.reason).toContain('[tsc] 1 type error');
      expect(first.response.reason).toContain('attempt 1 of 3');
    }
    expect(decide(report('failed'), state({ blocks: 2 }), { stop_hook_active: true }, 3).response.kind).toBe('block');
    const giveUp = decide(report('failed'), state({ blocks: 3 }), { stop_hook_active: true }, 3);
    expect(giveUp.response.kind).toBe('warn');
    // A fresh user turn starts counting again.
    expect(decide(report('failed'), state({ blocks: 3 }), { stop_hook_active: false }, 3).blocks).toBe(1);
    expect(decide(report('passed'), state({ blocks: 2 }), { stop_hook_active: true }, 3)).toEqual({ response: { kind: 'allow' }, blocks: 0 });
  });
});

describe('GitHub annotations', () => {
  it('emits one escaped ::error per file issue of a blocking gate, and a summary line otherwise', async () => {
    const { githubAnnotations } = await import('../src/cli/annotations.js');
    const report = aggregateReport({
      runId: 'r',
      startedAt: 't',
      finishedAt: 't',
      results: [
        {
          gate: 'content-lint',
          status: 'failed',
          summary: '1 content problem',
          durationMs: 1,
          issues: [{ severity: 'error', file: 'src/a, b.tsx', line: 3, column: 7, rule: 'lorem', message: 'lorem: "x"\nnext' }],
        },
        { gate: 'build', status: 'failed', summary: 'build failed: 100% broken', durationMs: 1, issues: [{ severity: 'error', message: 'exit code 1' }] },
        { gate: 'tsc', status: 'passed', summary: 'ok', durationMs: 1, issues: [] },
      ],
    });
    expect(githubAnnotations(report)).toEqual([
      '::error file=src/a%2C b.tsx,line=3,col=7,title=agent-gates content-lint::lorem: "x"%0Anext [lorem]',
      '::error title=agent-gates build::build failed: 100%25 broken',
    ]);
  });

  it('caps the number of annotations', async () => {
    const { githubAnnotations } = await import('../src/cli/annotations.js');
    const issues = Array.from({ length: 5 }, (_, i) => ({ severity: 'error' as const, file: 'a.ts', line: i + 1, message: 'm' }));
    const report = aggregateReport({ runId: 'r', startedAt: 't', finishedAt: 't', results: [{ gate: 'tsc', status: 'failed', summary: 's', durationMs: 1, issues }] });
    const lines = githubAnnotations(report, 3);
    expect(lines).toHaveLength(4);
    expect(lines[3]).toBe('::warning title=agent-gates::2 more problems not annotated; see the report artifact');
  });
});

describe('agent-gates.schema.json', () => {
  it('knows every built-in gate, alias and content rule', async () => {
    const { BUILTIN_GATE_IDS, GATE_ALIASES, BUILTIN_CONTENT_RULES } = await import('../src/index.js');
    const schema = JSON.parse(await readFile(new URL('../schema/agent-gates.schema.json', import.meta.url), 'utf8'));
    const gateKeys = Object.keys(schema.properties.gates.properties);
    for (const id of BUILTIN_GATE_IDS) expect(gateKeys, id).toContain(id);
    for (const [alias, target] of Object.entries(GATE_ALIASES)) {
      if (gateKeys.includes(alias)) expect(schema.properties.gates.properties[alias].$ref).toBe(schema.properties.gates.properties[target].$ref);
    }
    const ruleEnum: string[] = schema.$defs.contentLint.properties.disableRules.items.enum;
    expect([...ruleEnum].sort()).toEqual(BUILTIN_CONTENT_RULES.map((r) => r.id).sort());
  });

  it('is referenced from the config init writes', async () => {
    const dir = await tempProject({ 'package.json': '{}' });
    const d = await detectGates(dir, new FakeProbe());
    expect(renderConfig(d).split('\n')[0]).toMatch(/^# yaml-language-server: \$schema=https:\/\/unpkg\.com\/agent-gates@[^/]+\/schema\/agent-gates\.schema\.json$/);
  });
});

describe('Codex hook support', () => {
  it('init --codex writes .codex/hooks.json with a codex hook next to the Claude one', async () => {
    const dir = await tempProject({ 'package.json': '{}' });
    const r = await runInit({ cwd: dir, claude: true, codex: true, probe: new FakeProbe() });
    expect(r.steps.map((s) => `${s.action} ${s.file}`)).toContain('created .codex/hooks.json');
    const codex = JSON.parse(await readFile(join(dir, '.codex/hooks.json'), 'utf8'));
    expect(codex.hooks.Stop[0].hooks[0].command).toMatch(/agent-gates@\S+ hook codex$/);
    const claude = JSON.parse(await readFile(join(dir, '.claude/settings.json'), 'utf8'));
    expect(claude.hooks.Stop[0].hooks[0].command).toMatch(/hook claude$/);
  });

  it('addStopHook treats claude and codex entries as different hooks', () => {
    const settings: Record<string, unknown> = {};
    expect(addStopHook(settings, 'npx agent-gates hook claude')).toBe(true);
    expect(addStopHook(settings, 'npx agent-gates hook codex')).toBe(true);
    expect(addStopHook(settings, 'npx agent-gates hook codex')).toBe(false);
    const stop = (settings.hooks as { Stop: unknown[] }).Stop;
    expect(stop).toHaveLength(2);
  });

  it('findProjectRoot walks up to agent-gates.yaml, else package.json, and stops at the git root', async () => {
    const { findProjectRoot } = await import('../src/cli/run.js');
    const dir = await tempProject({
      'package.json': '{}',
      'packages/web/package.json': '{}',
      'packages/web/src/components/a.tsx': '',
      'packages/api/agent-gates.yaml': 'gates: {}\n',
      'packages/api/src/a.ts': '',
    });
    initRepo(dir);
    const real = (p: string) => join(dir, p);
    expect(await findProjectRoot(real('packages/web/src/components'))).toBe(real('packages/web'));
    expect(await findProjectRoot(real('packages/api/src'))).toBe(real('packages/api'));
    expect(await findProjectRoot(dir)).toBe(dir);
  });
});
