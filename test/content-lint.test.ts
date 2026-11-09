import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { globToRegExp, lintContent, lintText } from '../src/index.js';
import { makeTempDir, writeFiles } from './helpers.js';

const fixture = (name: string) => fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));

describe('content-lint on fixture dirs', () => {
  it('finds every forbidden pattern in the dirty fixture, with file/line/column', async () => {
    const result = await lintContent(fixture('content-dirty'));
    const summary = result.findings.map((f) => `${f.file}:${f.line}:${f.rule}`);
    expect(summary).toEqual(
      expect.arrayContaining([
        'README.md:3:todo',
        'README.md:5:empty-href',
        'content/home.json:3:lorem',
        'content/home.json:4:example-domain',
        'content/home.json:5:empty-href',
        'content/home.json:8:placeholder',
        'content/home.json:8:todo',
        'public/index.html:3:empty-href',
        'public/index.html:4:placeholder',
      ]),
    );
    expect(result.findings).toHaveLength(9);
    const lorem = result.findings.find((f) => f.rule === 'lorem');
    expect(lorem).toMatchObject({ column: 18, match: 'Lorem ipsum' });
    expect(result.findings.find((f) => f.rule === 'placeholder' && f.file.endsWith('.json'))?.match).toBe('{LAUNCH_DATE}');
  });

  it('skips specs/ and test dirs by default (spec placeholders and test emails are legitimate)', async () => {
    const result = await lintContent(fixture('content-dirty'));
    expect(result.findings.some((f) => f.file.startsWith('specs/') || f.file.startsWith('e2e/'))).toBe(false);
  });

  it('reports nothing for the clean fixture (anchors, ICU {count}, real domains are fine)', async () => {
    const result = await lintContent(fixture('content-clean'));
    expect(result.findings).toEqual([]);
    expect(result.filesScanned).toBe(3);
  });

  it('honours include/exclude globs, disabled rules and custom patterns', async () => {
    const onlyJson = await lintContent(fixture('content-dirty'), { include: ['content/**'] });
    expect(new Set(onlyJson.findings.map((f) => f.file))).toEqual(new Set(['content/home.json']));

    const noReadme = await lintContent(fixture('content-dirty'), { exclude: ['README.md'], disableRules: ['todo', 'placeholder'] });
    expect(noReadme.findings.map((f) => f.rule).sort()).toEqual(['empty-href', 'empty-href', 'example-domain', 'lorem']);

    const custom = await lintContent(fixture('content-clean'), { patterns: ['founding access'] });
    expect(custom.findings).toEqual([expect.objectContaining({ rule: 'pattern:1', file: 'content/home.json', line: 4 })]);
  });
});

describe('content-lint on code files', () => {
  let cleanup: (() => Promise<void>) | undefined;
  afterEach(async () => {
    await cleanup?.();
    cleanup = undefined;
  });

  it('treats {NAME} in code as a placeholder only when NAME is not a real identifier', async () => {
    const tmp = await makeTempDir();
    cleanup = tmp.cleanup;
    await writeFiles(tmp.dir, {
      'app/page.tsx': [
        "import { SITE_NAME } from '../lib/site';",
        'export default function Page() {',
        '  return (<main>',
        '    <h1>{SITE_NAME}</h1>',
        "    <p>{'Launching on {LAUNCH_DATE}'}</p>",
        '    <a href="">Buy</a>',
        '    <span>{`${SITE_NAME} rocks`}</span>',
        '  </main>);',
        '}',
      ].join('\n'),
      'lib/site.ts': "export const SITE_NAME = 'Artelo'; // TODO rename\n",
      'app/page.test.tsx': "const email = 'a@example.com'; // TODO\n",
      'node_modules/pkg/index.js': '// TODO lorem ipsum\n',
      '.next/server.js': 'lorem\n',
      'next-env.d.ts': '// TODO\n',
    });
    const result = await lintContent(tmp.dir);
    expect(result.findings.map((f) => `${f.file}:${f.line}:${f.rule}:${f.match}`)).toEqual([
      'app/page.tsx:5:placeholder:{LAUNCH_DATE}',
      'app/page.tsx:6:empty-href:href=""',
      'lib/site.ts:1:todo:TODO',
    ]);
  });

  it('supports line and file suppressions', () => {
    expect(lintText('a.md', 'lorem ipsum <!-- content-lint-ignore -->\nTODO\n').map((f) => f.rule)).toEqual(['todo']);
    expect(lintText('a.md', '<!-- content-lint-ignore-file -->\nlorem\n')).toEqual([]);
  });

  it('flags empty hrefs in every syntax', () => {
    const rules = (text: string) => lintText('x.tsx', text).map((f) => f.rule);
    expect(rules('<a href="">x</a>')).toEqual(['empty-href']);
    expect(rules("<a href=''>x</a>")).toEqual(['empty-href']);
    expect(rules('<a href={""}>x</a>')).toEqual(['empty-href']);
    expect(rules('<a href="#">x</a>')).toEqual(['empty-href']);
    expect(rules('<a href="#pricing">x</a>')).toEqual([]);
    expect(rules('<a href="/x">x</a>')).toEqual([]);
  });
});

describe('globToRegExp', () => {
  it('matches like gitignore-style globs', () => {
    expect(globToRegExp('**/*.test.*').test('src/a.test.ts')).toBe(true);
    expect(globToRegExp('**/*.test.*').test('a.test.ts')).toBe(true);
    expect(globToRegExp('e2e/**').test('e2e/x/y.ts')).toBe(true);
    expect(globToRegExp('e2e/**').test('src/e2e.ts')).toBe(false);
    expect(globToRegExp('README.md').test('docs/README.md')).toBe(true);
    expect(globToRegExp('content/*.{json,md}').test('content/a.md')).toBe(true);
    expect(globToRegExp('content/*.{json,md}').test('content/sub/a.md')).toBe(false);
  });
});
